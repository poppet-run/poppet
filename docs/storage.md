# Storage

[Engineering notes](README.md)

Poppet keeps durable state in one SQLite database at
`<POPPET_DATA_DIR>/store/poppet.sqlite`. Every package that needs tables defines
and migrates its own, on the one connection that `@poppet/store` opens. The
[user guide](https://poppet.run/docs/storage/) covers the data directory and
backups. See [development](development.md#store-migrations) for how to add a
migration.

## Database

`store/src/database.ts` protects the `store` directory (`0700`), takes the owner
lock, and opens one Effect SQL client on
[Bun SQLite](https://bun.sh/docs/runtime/sqlite) with foreign keys, WAL, and full
synchronous commits. The database and WAL sidecars are `0600`. Rows come back
with camelCase names. Scope finalizers close SQLite before releasing the lock,
including after interruption or a failed start.

`StoreLive` provides the `Store` record service and the shared `SqlClient`. Other
packages query `SqlClient` through their own repositories. The `Store` API exposes
no raw handle and has no memory, task, or gateway operations. `store status`
migrates and prints the path, schema version, and counts without opening any
authentication service. Help, configuration, skill, and provider commands never
open the database.

## Owner lock

`credentials/src/lock.ts` gives one process ownership of a data directory. The
store, ChatGPT credentials, and API-key changes all use it. The lock is a small
SQLite database, `store/owner.lock.sqlite`, held with
[exclusive locking](https://www.sqlite.org/pragma.html#pragma_locking_mode), which
stays held across transactions and is released by the OS when the process exits
or crashes. An atomic PID marker, `store/owner.lock`, records the owner for
diagnostics only. Once the SQLite lock is held, a leftover regular marker is
replaced without checking whether its PID is alive. An invalid marker file fails
closed. Lock databases hold no credentials or records, stay after logout, and must
never be removed while Poppet runs.

## Migrations

Each package exports a `PackageSchema` with its own ledger table, version, and
migrations keyed `<id>_<name>`, one SQL statement per array entry. `migrate` in
`store/src/migrations.ts` runs one package's pending migrations with Effect's SQL
migrator in a single transaction, so a failure rolls back the batch. The
migrator records IDs only, so it cannot detect an edited migration.

| Package           | Defined in                               | Tables                                                                                                            |
| ----------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@poppet/store`   | `store/src/migrations/`                  | `sessions`, `runs`, `messages`, `tool_calls`, `attachments`, `session_search`, and the `searchable_messages` view |
| `@poppet/memory`  | `memory/src/migrations.ts`               | `memory_revisions` and the `memories` view                                                                        |
| `@poppet/tasks`   | `tasks/src/migrations.ts`                | `jobs`, `job_occurrences`, `job_skips`, `job_provider_pauses`, `job_notes`                                        |
| `@poppet/gateway` | `gateway/src/migrations.ts`              | `gateway_bindings`, `gateway_inbox`, `gateway_deliveries`                                                         |
| Web chat          | `apps/cli/src/commands/web-chat/chat.ts` | `web_chat_submissions`                                                                                            |

The store migrates its own tables first. Each other package migrates when its
layer starts. The gateway migrates the task schema first, because it reads
occurrences. The store refuses a ledger newer than the build, a database from
another application, and a development database from before the baseline. Those
need a fresh data directory. Nothing resets a database by itself.

## Sessions and messages

A session saves its provider and model, title metadata, an optional
[skill snapshot](skills.md#snapshots), and its origin (`chat`, `scheduled`, or
`gateway:<id>`, added by store migration 6 for the web sidebar). Migration 6
classified existing sessions from task titles, occurrences, gateway bindings, and
inbox history. A session with no evidence of either is `chat`.

Title metadata has the title, its source, an attempt claim, and separate title
usage. A manual title wins over a generated one. Title changes never touch
activity timestamps.

Messages keep their order, tool call IDs, tool results, and versioned provider
continuation. Continuation holds the readable reasoning the provider returned,
saved whether or not `chat.logReasoning` is on, plus any encrypted reasoning.
`service.ts` checks continuation identity on write and on read. A user message
can carry a `skills` array of `name` and `content` from
[mentions](skills.md#mentions) in its JSON payload.

Store migration 3 added `attachments`. Attachment bytes are saved in the
transaction that saves the user message, keyed by attachment ID and session. The
message holds only each attachment's ID, name, type, and size.

## Runs

Table checks define valid states, and services rely on them:

- `queueRun` saves a pending run and its input messages in one transaction.
- `startRun` accepts only pending runs.
- A pending run can fail or be interrupted. Completion needs a running run.
- `finishRun` saves a completed response and its assistant message in one
  transaction, or records a failure or interruption reason.
- A partial unique index allows one pending or running run per session. Other
  sessions run at the same time.
- Runs read their provider and model from the session.

A new owner marks unfinished runs interrupted with `process-exit`. Their inputs
stay, and nothing replays them.

## Tool call journal

`tool_calls` records every tool call. One transaction saves the assistant tool
request with its pending calls, and another saves a completed result with its
transcript message. States go from pending to running to completed or failed.
When a run fails or a new owner opens the store, pending calls become interrupted
and running calls become uncertain. Completed calls never change, and terminal
calls never restart.

MCP calls fill the nullable `server_id` and `tool_name`. Store migration 5 added
review metadata, which reviewed calls save before dispatch. A call interrupted
during review stays interrupted. A call interrupted after dispatch is uncertain.

`Store.commitToolCall` runs a synchronous change, such as a task edit, together
with completing its tool call and message. If saving the result fails, the change
rolls back. A completed call returns its saved result instead of running again.
CLI and worker commands have no such deduplication.

## Facts

`memory_revisions` is append-only and is the only place facts live. Each row has
the key, the value (null when forgotten), the origin (`cli` or `turn`), the
source run, and the time. The `memories` view shows each key's latest revision
unless that revision forgot it.

## Tasks

A job has a definition revision that rises on every name, prompt, or schedule
edit. An occurrence saves the revision and a JSON definition, so later edits do
not change it. Its unique slot is `(job_id, revision, scheduled_at)`, and a
partial unique index allows one pending or running occurrence per job.
`scheduled_at` is the logical slot and `available_at` decides eligibility and
expiry. `origin` tells scheduled work from manual runs.

- Task migration 3 added `jobs.end_at`, the last instant a slot may fall on. It is
  not part of the occurrence definition, so changing it keeps the revision.
- Task migration 4 added `job_notes`, one row per note change, with the text,
  `origin` (`occurrence` or `cli`), occurrence, run, and time. The latest row is
  the current note.
- `job_skips` records skipped intervals, and `job_provider_pauses` records
  provider holds.

Jobs and occurrences have nullable JSON `destination` columns. An occurrence
copies the adapter, bot account, owner, server, parent, and thread IDs when it is
queued. Apart from notes, tasks keep no change history beyond their occurrences
and skips. Clearing tasks cascades to occurrences and notes.

## Gateway

`gateway_bindings` maps a conversation to its session, with creation provenance,
confirmed and pending remote names, the last title considered, and whether naming
was turned off. `gateway_inbox` is the durable request queue.
`gateway_deliveries` holds reply and scheduled result chunks. A unique
`(occurrence_id, run_id)` index stops duplicate scheduled entries and still lets
a successful retry deliver. Delivery state is independent of task execution, so
queued replies survive clearing tasks. See [gateways](gateways/discord.md).

## Session deletion

`chat delete` takes one or more session IDs. It deletes nothing if any ID is
missing or any session has a reply in progress. `chat prune --days <n>` (1 to 36500) deletes sessions whose last activity is older than that, and skips
sessions with a reply in progress. Renaming is not activity. Both go through the
worker when it owns storage.

Deleting a session removes its search entries, tool calls, messages,
attachments, runs, and the session in one transaction. Each package detaches its
own references through `BEFORE DELETE` triggers from its migrations:

| Migration  | Trigger effect                                 |
| ---------- | ---------------------------------------------- |
| Task 5     | Clears occurrence and note links               |
| Gateway 2  | Removes thread bindings and clears inbox links |
| Web chat 2 | Removes submission receipts                    |
| Memory 2   | Clears `source_run_id`                         |

Memory migration 2 also rebuilt `memory_revisions`, so a `turn` revision may have
no source run. Deletion applies every package's pending migrations first, so the
triggers exist even when that package has not started since an upgrade.

## Search index

`session_search` is an FTS5 index over the `searchable_messages` view: completed
user messages and final assistant text. A trigger on run completion indexes the
exchange in the completion transaction, so an indexing failure rolls back the
completion. Messages are the source of truth. Titles join from sessions at query
time, so a rename shows at once.

`Store.searchSessions` and `Store.readSession` in `search.ts` and `recall.ts`
serve both the CLI and the agent on the owning connection. `readSession` reads at
most eleven rows for forward paging, or six on each side of an anchor including
lookahead, and SQL bounds each text before it reaches the agent. See
[conversation recall](chat.md#conversation-recall) for the query and result rules.
