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
explicitly saved facts and their revisions, and session titles with their source,
a durable automatic-attempt claim, and separate title-request usage.
Manual titles take precedence over automatic results, and metadata
updates leave session activity timestamps unchanged. Gateway bindings also retain
creation provenance, confirmed and pending remote names, the last title considered
for synchronization, and whether external edits or failures disabled naming.

`@poppet/store` provides a scoped Effect `Store` service backed by
[Bun SQLite](https://bun.sh/docs/runtime/sqlite) through the Effect SQL client.
Each package migrates its own tables: the store creates conversations, and memory,
tasks, and gateway create theirs when their layers start. Table checks define which
record states are valid. Effect's migrator records each package's applied
migration IDs in its own ledger table and runs that package's pending migrations
in one transaction; a failure rolls back the batch.
The store refuses databases from newer versions, from other applications, and
from development builds before the baseline. Those need a fresh data directory;
databases are never reset automatically.

Sessions retain their selected provider and model. Messages preserve order,
tool call IDs, tool
results, and versioned provider continuation. Runs persist pending
inputs before execution, then transition through running to completed, failed,
or interrupted. Successful completion writes its assistant message and result
in one transaction. The store validates continuation identity on write and read.
It permits one pending or running run per session; different sessions can run at
the same time. Store migration 2 replaced the earlier rule of one active run across
all sessions.

Store migration 3 adds the `attachments` table. A run's attachment bytes are saved
in the same transaction as the user message that references them, keyed by
attachment ID and session. Messages hold only each attachment's ID, name, type,
and size. Attachments stay in the database with their session, so backups and
the permissions below cover them.

## Task revisions and timing

Jobs carry a monotonically increasing definition revision. Occurrences save that
revision and a JSON execution definition, independently of the mutable job. Their
unique slot is `(job_id, revision, scheduled_at)`; the partial unique index still
permits at most one pending/running occurrence per job. `available_at` controls
eligibility and recurring expiration, while `scheduled_at` identifies the logical
slot. `origin` distinguishes scheduled and manual work. Legacy rows are backfilled
from the previously immutable job definition and their own destination snapshot.

Definition edits, occurrence replacement, and timing changes commit together.
Task changes keep no separate history: occurrences and skipped intervals record
what ran and what did not. Clearing tasks cascades to their occurrences, preserving
existing chat and queued-delivery behavior.

## Scheduled delivery destinations

Chat task mutations and their completed tool result/message commit in one
shared-database transaction, keyed by run and call ID. Failure to save the tool
result rolls back the task change. Repeating a completed call returns its saved
result, and a later model failure does not undo a committed task. This tool
journal is the only replay protection; CLI and worker commands are not
deduplicated, and there is no automatic execution replay.

Jobs and occurrences have nullable JSON `destination` columns.
Each occurrence copies the task's adapter, bot account, owner, server, parent
channel, and thread IDs when queued. Tasks without messaging delivery have no
destination.
The gateway copies completed answers into its delivery queue using a unique
`occurrence_id` on the inbox record, so recovery cannot enqueue the result twice.
Delivery chunks retain their own state independently of task execution. Queued
replies and their saved answers survive clearing task definitions and history.

## Skill snapshots

Sessions and jobs have nullable JSON `skill` columns. Each selected
skill saves its validated `name` and full `content` at creation. Records created
without a selected skill have no snapshot. Task occurrences copy their task's
snapshot into the new session; no later run rereads the skill file. Inspection
exposes snapshots without provider
continuation or credentials. See [skills](skills.md).

## Fact history

The append-only `memory_revisions` table is the only place facts are stored. It
records every remember, replace, forget, and revert per key, with the value (null
when forgotten), origin (`cli` or `turn`), source run, and time. The `memories`
view shows each key's latest revision unless that revision forgot it. CLI changes
have no source run; model changes always do.

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
remains a separate manual check.
