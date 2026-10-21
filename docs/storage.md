# Storage

[Documentation index](index.md)

Open or inspect the local database:

```fish
bun run start store status
```

This opens `<POPPET_DATA_DIR>/store/poppet.sqlite`, applies pending migrations,
and prints its path, schema version, and session/message/run counts. It requires
no login or selected model. Help, configuration, and auth commands do not open
this database. To experiment in a separate directory:

```fish
set -lx POPPET_DATA_DIR /tmp/poppet-storage-test
bun run start store status
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
processing results and source-aware recall without resetting saved data.
Migration SQL lives in timestamped TypeScript files under
`packages/store/src/migrations/`, registered in order by `migrations.ts`.
A checksummed migration ledger rejects newer schemas and changed migration
history. All pending migrations commit together; a failure rolls back the pending
batch.

The unreleased base migration history was consolidated into schema version 1;
the current schema is version 4. Existing version-1 through version-3 databases upgrade in place.
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

## Monitoring observations

`jobs.monitor` distinguishes recurring monitors from reporting tasks and defaults
to false for existing jobs. `job_monitor_results` records one successful decision
per occurrence, with the stable value, summary, source-call references, original
observation time, previous value, and `baseline`, `unchanged`, or `changed`
decision. Changed decisions also save the notification payload. Commit order
selects the most recent successful observation even when timestamps tie or move
backward. No separate baseline store or raw-source copy is maintained.

`monitor_baseline_after` is a per-job result-ID boundary. A prompt edit advances
it without deleting old observations; future comparisons use results after that
boundary and establish a new quiet baseline. `monitor_revision` prevents explicit
retry of occurrences from before that prompt change. Name and schedule edits do
not move the boundary. Inspection retains historical `lastObservation` and exposes
the current `baselineObservation` separately.

The decision and completed occurrence commit in one transaction after the linked
model run completes. Recovery uses the same validation and comparison against
saved tool calls, without invoking the model or reading sources again. A missing
or invalid observation fails the occurrence while retaining the completed run
for inspection. Failed, interrupted, and cancelled checks cannot advance the
baseline. Repeated finalization cannot create another decision.

Only changed monitor results enter the existing gateway queue. The unique
occurrence identity prevents duplicate enqueueing. Baseline advancement and
remote delivery success remain separate. Clearing tasks cascades to monitoring
results while retaining saved runs and queued gateway replies.

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
A dead owner is recovered automatically. Unknown legacy markers still require
manual removal after confirming no old Poppet process owns the storage.
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
failures retain a bounded reason. The inbox keeps the original opaque Telegram
file reference and caption. No token-bearing download URL is saved.

Accepted text commits before the reserved run ID is started. Restart reuses it;
interruptions before acceptance can retry local processing at most three times.
Completed runs and deliveries retain the existing deduplication and uncertain-send
rules. Existing text-only inbox/message records need no attachment fields.

User message payloads keep the owner's request in `text` and extracted provenance
in optional `source`. Context assembly converts the source to labelled untrusted
JSON text; recall and the existing FTS projection preserve that label and include
accepted source text for completed runs. No separate document index is created.

Raw PDF/audio files live under private generated directories in
`<data directory>/attachment-tmp`, with `0700` directories and `0600` input files.
Scoped cleanup removes them on completion, failure or cancellation; worker startup
removes only this feature's abandoned directories. UTF-8 documents can be processed
in memory. Saved transcripts, extracted text, source metadata, answers and provider
records are separate from temporary raw files and follow existing history retention.
