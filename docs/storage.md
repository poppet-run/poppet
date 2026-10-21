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
base schema; migration 2 adds change-aware monitoring without resetting version-1
data. Migration SQL lives in timestamped TypeScript files under
`packages/store/src/migrations/`, registered in order by `migrations.ts`.
A checksummed migration ledger rejects newer schemas and changed migration
history. All pending migrations commit together; a failure rolls back the pending
batch.

The unreleased base migration history was consolidated into schema version 1;
the current schema is version 2. Existing version-1 databases upgrade in place.
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

## Monitoring observations

`jobs.monitor` distinguishes recurring monitors from reporting tasks and defaults
to false for existing jobs. `job_monitor_results` records one successful decision
per occurrence, with the stable value, summary, source-call references, original
observation time, previous value, and `baseline`, `unchanged`, or `changed`
decision. Changed decisions also save the notification payload. Commit order
selects the most recent successful observation even when timestamps tie or move
backward. No separate baseline store or raw-source copy is maintained.

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
