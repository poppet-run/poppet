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
explicitly saved facts in `memories`.

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
