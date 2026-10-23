# Storage

[Documentation index](README.md)

Open or inspect the local database:

```sh
poppet store status
```

This opens `<POPPET_DATA_DIR>/store/poppet.sqlite`, applies pending migrations,
and prints its path, schema version, and session/message/run counts. It requires
no login or selected model. Help, configuration, and auth commands do not open
this database. To experiment in a separate directory:

Bash / POSIX sh:

```sh
export POPPET_DATA_DIR=/tmp/poppet-storage-test
poppet store status
```

fish:

```fish
set -lx POPPET_DATA_DIR /tmp/poppet-storage-test
poppet store status
```

## Schema and saved records

The initial schema includes durable tool calls and their execution states,
explicitly saved facts in `memories`, and session titles with their source,
a durable automatic-attempt claim, and separate title-request usage.
Manual titles take precedence over automatic results, and metadata
updates leave session activity timestamps unchanged. Gateway bindings also retain
creation provenance, confirmed and pending remote names, the last title considered
for synchronization, and whether external edits or failures disabled naming.

`@poppet/store` provides a scoped Effect `Store` service backed by
[Bun SQLite](https://bun.sh/docs/runtime/sqlite). The initial migration creates the
base schema; migration 2 adds change-aware monitoring, migration 3 adds task
controls and immutable occurrence definitions, and migration 4 adds attachment
processing results and source-aware recall. Migration 5 adds project snapshots
and scoped facts without resetting saved data. Migration 6 adds learned skills
and their revision history. Migration 7 adds fact origins and fact revision
history. Migration 8 adds the background review queue.
Migration SQL lives in timestamped TypeScript files under
`packages/store/src/migrations/`, registered in order by `migrations.ts`.
A checksummed migration ledger rejects newer schemas and changed migration
history. All pending migrations commit together; a failure rolls back the pending
batch.

The unreleased base migration history was consolidated into schema version 1;
the current schema is version 9. Existing version-1 through version-8 databases upgrade in place.
Development databases created with the former 14-step history are still rejected.
Those legacy databases require a fresh data directory; databases are never reset
automatically.

Sessions retain their selected provider, model, and workload. Sessions and runs
default to the `assistant` workload. Messages preserve order, tool call IDs, tool
results, and versioned provider continuation. Runs persist pending
inputs before execution, then transition through running to completed, failed,
or interrupted. Successful completion writes its assistant message and result
in one transaction. The store validates continuation identity on write and read.
It permits one pending or running run across all sessions.

## Task revisions and timing

Jobs carry a monotonically increasing definition revision. Occurrences save that
revision and a JSON execution definition, independently of the mutable job. Their
unique slot is `(job_id, revision, scheduled_at)`; the partial unique index still
permits at most one pending/running occurrence per job. `available_at` controls
eligibility and recurring expiration, while `scheduled_at` identifies the logical
slot. `origin` distinguishes scheduled and manual work. Legacy rows are backfilled
from the previously immutable job definition and their own destination snapshot.

`job_operations` saves request identity, command, immutable receipt, time, and
changed before/after fields or execution target. Exact request replay returns
the original receipt; reusing an ID for different arguments is rejected. No-op
receipts retain replay protection without appearing as changes. Definition edits,
occurrence replacement, timing changes, history, and receipts commit together.
Chat also completes its tool journal/message in that transaction. Clearing tasks
cascades to operations, preserving existing chat and queued-delivery behavior.

Migration 3 rebuilds occurrence uniqueness while preserving original IDs,
monitor-result ordering, child foreign keys, and all unrelated records. The child
monitoring table is copied before replacing its parent; migration rollback leaves
both original tables and the version ledger intact.

## Scheduled delivery destinations

Jobs have nullable `source_run_id` and `source_call_id` columns,
with a unique source-call index. Tasks created outside chat have no tool origin.
Chat task mutations and their completed tool result/message commit in one shared-database
transaction. Failure to save the receipt rolls back the task change. Repeating a
completed call returns its original saved receipt, and a later model failure does
not undo a committed task. This reuses the tool journal without introducing
automatic execution replay.

Jobs and occurrences have nullable JSON `destination` columns.
Each occurrence copies the task's adapter, bot account, owner, server, parent
channel, and thread IDs when queued. Tasks without messaging delivery have no
destination.
The gateway copies completed answers into its delivery queue using a unique
`occurrence_id` on the inbox record, so recovery cannot enqueue the result twice.
Delivery chunks retain their own state independently of task execution. Queued
replies and their saved answers survive clearing task definitions and history.

## Messaging polling progress

`gateway_cursors` stores polling progress by adapter and bot account. Polling
updates commit to the inbox before advancing their cursor. Rejected input can
advance deliberately; overload or storage failure preserves the previous cursor.
Inbox deduplication covers a crash between those commits. Message bindings,
acceptance identities, and polling offsets stay separate across adapters/accounts.

## Skill snapshots

Sessions and jobs have nullable JSON `skill` columns. Each selected
skill saves its validated `name` and full `content` at creation. Records created
without a selected skill have no snapshot. Task occurrences copy their task's
snapshot into the new session; no later run rereads the skill file. Inspection
exposes snapshots without provider
continuation or credentials. See [skills](skills.md).

## Retired learning data

Migrations 6 and 8 remain unchanged so existing databases still open. Their
`learned_skills`, `skill_revisions`, and `learning_reviews` tables are retained
as archived data. Poppet no longer reads, writes, or runs background reviews.
Export any learned procedures you want to keep into owner-written `SKILL.md` files.

## Fact history

Migration 7 adds an `origin` column to `memories` (`cli`, `turn`, or `review`),
set to `turn` for existing facts with a source run and `cli` otherwise. The
append-only `memory_revisions` table records every remember, replace, forget,
and revert per key, with the value (null when forgotten),
origin, source run, and time. Existing facts are backfilled as revision 1. CLI
changes have no source run; model changes always do.

## Conversation search index

The schema includes an FTS5 index for completed user messages and final
assistant text. Intermediate responses, tool data, failed/interrupted inputs,
and provider continuation are excluded. A trigger on successful run completion
updates the index in the same transaction as the final message and run result.
Indexing failures roll back completion. Messages remain the source of truth;
titles are read from sessions at query time so manual renames appear immediately.

`Store.searchSessions` accepts a bounded plain-text query and a serialized JSON
byte budget. It quotes and binds FTS terms, returns at most ten relevance-ranked
matches with stable message-ID ordering for ties, and bounds excerpts and output.
The CLI and agent tool use this same operation on the owning store connection.
Agent and CLI recall can inspect all saved sessions.
See [conversation search](chat.md#search-past-conversations).

`Store.readSession` uses the same indexed eligible message IDs and the
`searchable_messages` projection over original saved messages. It reads at most
eleven rows for forward paging, or six on each side of an around-message anchor
including lookahead. SQL bounds each returned text before it reaches the agent.
It creates no new index, summary, transcript copy, or schema migration.

The result has at most ten chronological messages and fits the supplied JSON
byte budget. Stable message anchors must belong to the requested session and
eligible history. Per-message and overall truncation flags mark shortened text
and omitted context; `nextAfterMessageId` advances past the last returned message,
including a shortened one. Current titles are read without changing session
activity. See [conversation context](chat.md#read-conversation-context).

## Permissions and recovery

The store directory uses `0700` permissions; the database and WAL sidecars use
`0600`. Credentials stay in the separate `auth` directory. The store holds an
exclusive ownership until its SQLite connection closes, including on interruption
and initialization failure. A shared helper uses an OS-held SQLite lock in
`store/owner.lock.sqlite` and an atomic PID marker in `store/owner.lock`.
The OS releases the SQLite lock when an owner exits or crashes, so a leftover
marker is replaced automatically, even if its PID now belongs to another process.
The marker records the current owner for diagnostics only.
Never remove a `.lock.sqlite` file while Poppet is running. These small lock
databases contain no credentials and remain after logout. On reopening, unfinished runs become interrupted
with a `process-exit` reason. Poppet does not automatically replay them.

Tests cover persistent tool exchanges for all providers, migration ordering and
rollback, transaction rollback, invalid records, run transitions, competing
owners, and scoped cleanup. Live ChatGPT token renewal
remains a separate phase 3 follow-up.

## Attachment retention

`gateway_attachments` is keyed to the accepted inbox entry and records processing,
accepted, or failed state. Accepted results contain a SHA-256 content hash,
extraction version, safe filename/MIME, completeness label and bounded text;
failures retain a bounded reason. The inbox keeps the original opaque adapter
file reference and caption. No token-bearing download URL is saved.

Accepted text commits before the reserved run ID is started. Restart reuses it;
interruptions before acceptance can retry local processing at most three times.
Completed runs and deliveries retain the existing deduplication and uncertain-send
rules. Existing text-only inbox/message records need no attachment fields.

User message payloads keep the owner's request in `text` and extracted provenance
in optional `source`. Context assembly converts the source to labelled untrusted
JSON text; recall and the existing FTS projection preserve that label and include
accepted source text for completed runs. No separate document index is created.

Text attachments are processed in memory without raw files on disk. Saved text,
source metadata, answers and provider records follow existing history retention.
Previously saved PDF text and voice transcripts remain readable. Old
`<data directory>/attachment-tmp` directories from interrupted PDF/audio processing
are no longer used or cleaned by Poppet; after stopping the old worker, they can
be removed without deleting saved history.

## Retired project data

Project selection has been removed. Existing project columns, occurrence JSON,
facts, and revision histories remain in SQLite; project files are untouched.
They are no longer loaded as instructions or active facts. Current memory uses
only the global scope, so conflicting keys are never merged. Export any project
facts you still need and save them explicitly with `memory remember`.

Existing conversations and tasks still load. Recall and task controls now cover
all saved records. Review task prompts that depended on project instructions;
put required context in the prompt or a skill when creating replacement tasks.

## Retired monitoring data

Migration 9 pauses existing monitor jobs, clears their next run, cancels pending
checks, and interrupts unfinished checks. It stops pending alerts and marks
in-flight deliveries uncertain. Completed runs and observation history remain
in SQLite. Archived monitors are excluded from task commands and new delivery.
Ordinary one-off and recurring tasks are unchanged. To replace a monitor, create
a regular cron task; it reports every successful run.
