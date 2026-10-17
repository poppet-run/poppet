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

Migration 4 adds durable tool calls and their execution states. Migration 5 adds
explicitly saved facts in `memories`. Migration 8 adds session titles, their
source, a durable automatic-attempt claim, and separate title-request usage.
Existing sessions keep null titles; there is no backfill or inference on old
history. Manual titles take precedence over automatic results, and metadata
updates leave session activity timestamps unchanged. Gateway bindings also retain
creation provenance, confirmed and pending remote names, the last title considered
for synchronization, and whether external edits or failures disabled naming.

`@poppet/store` provides a scoped Effect `Store` service backed by
[Bun SQLite](https://bun.sh/docs/runtime/sqlite). The initial migrations create
sessions, messages, runs, and history indexes. A checksummed migration ledger
rejects newer schemas and changed migration history. All pending migrations
commit together; a failure rolls back the pending batch.

Sessions retain their selected provider, model, and workload. Migration 3 adds
workload to sessions and runs, defaulting existing records to `assistant`.
Messages preserve order, tool
call IDs, tool results, and versioned provider continuation. Runs persist pending
inputs before execution, then transition through running to completed, failed,
or interrupted. Successful completion writes its assistant message and result
in one transaction. The store validates continuation identity on write and read.
It permits one pending or running run across all sessions.

## Scheduled delivery destinations

Migration 13 adds nullable `source_run_id` and `source_call_id` columns to jobs,
with a unique source-call index. Existing tasks retain no tool origin. Chat task
mutations and their completed tool result/message commit in one shared-database
transaction. Failure to save the receipt rolls back the task change. Repeating a
completed call returns its original saved receipt, and a later model failure does
not undo a committed task. This reuses the tool journal without introducing
automatic execution replay.

Migration 11 adds nullable JSON `destination` columns to jobs and occurrences.
Each occurrence copies the task's adapter, bot account, owner, server, parent
channel, and thread IDs when queued. Existing records retain no destination.
The gateway copies completed answers into its delivery queue using a unique
`occurrence_id` on the inbox record, so recovery cannot enqueue the result twice.
Delivery chunks retain their own state independently of task execution. Queued
replies and their saved answers survive clearing task definitions and history.

## Messaging polling progress

Migration 12 adds `gateway_cursors`, keyed by adapter and bot account. Polling
updates commit to the inbox before advancing their cursor. Rejected input can
advance deliberately; overload or storage failure preserves the previous cursor.
Inbox deduplication covers a crash between those commits. Message bindings,
acceptance identities, and polling offsets stay separate across adapters/accounts.

## Skill snapshots

Migration 10 adds nullable JSON `skill` columns to sessions and jobs. Each selected
skill saves its validated `name` and full `content` at creation. Existing records
have no skill. Task occurrences copy their task's snapshot into the new session;
no later run rereads the skill file. Inspection exposes snapshots without provider
continuation or credentials. See [skills](skills.md).

## Conversation search index

Migration 9 creates an FTS5 index and backfills completed user messages and final
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

Tests cover persistent tool exchanges for all providers, upgrades and migration
rollback, transaction rollback, invalid records, run transitions, competing
owners, and scoped cleanup. Live ChatGPT token renewal
remains a separate phase 3 follow-up.
