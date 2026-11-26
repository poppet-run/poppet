# Memory

[Engineering notes](README.md)

Memory is three inputs that every run reads once at start: the personality in
`soul.md`, the owner's profile in `profile.md`, and saved facts. The
[user guide](https://poppet.run/docs/memory/) covers the `memory` commands.

| Module                                | Owns                                                |
| ------------------------------------- | --------------------------------------------------- |
| `packages/memory/src/service.ts`      | The `Memory` service and `MemoryError`              |
| `packages/memory/src/schema.ts`       | Key, value, origin, and snapshot schemas and limits |
| `packages/memory/src/local.ts`        | `LocalMemoryLive`, fact SQL, and bounded snapshots  |
| `packages/memory/src/context-file.ts` | Bounded reads of `soul.md` and `profile.md`         |
| `packages/memory/src/migrations.ts`   | The memory schema                                   |
| `packages/agent/src/memory.ts`        | Formatting the snapshot into model instructions     |
| `packages/agent/src/memory-tools.ts`  | The `poppet_memory.memory` tool                     |

## Service

`Memory` has `snapshot`, `list`, `remember`, `replace`, and `forget`.
`LocalMemoryLive` appends to `memory_revisions` and reads current facts from the
`memories` view. The memory package owns its tables. The store provides the
database and owner lock and exposes the shared `SqlClient`, so the CLI hands one
connection to the conversation store and to memory. The conversation `Store` has
no memory operations and does not depend on this package.

The CLI selects `LocalMemoryLive` directly. Another implementation can supply
`Memory` without changes to the agent or the command handlers. Memory commands
need no provider or model.

## Facts

- Keys start with a letter or digit and contain letters, digits, dots,
  underscores, and hyphens, up to 128 characters.
- Values are nonempty, have no surrounding whitespace, and fit in 4096 UTF-8
  bytes.
- The store keeps at most 128 facts. The serialized keys and values must fit the
  8 KiB facts budget, which is fixed. If older facts exceed it, snapshots fail until the owner
  shortens or forgets some.
- Every change appends a revision with an origin: `cli` for commands, `turn` for
  the memory tool. A `turn` revision records its source run, which becomes null if
  that session is [deleted](storage.md#session-deletion).
- Revision timestamps stay ordered even if the clock moves backwards.
- `memory revert <key> <n>` appends a revision that restores revision `n`.
  Restoring a forgotten revision forgets the fact again.
- `memory history` and `memory revert` go through a running worker.

## Snapshots

The agent asks for one snapshot at run start and passes the chat policy's
personality, profile, and facts budgets, each 8 KiB by default. The first two
are `limits.soulBytes` and `limits.profileBytes`. The snapshot
holds personality and profile text and facts in key order, without provenance.
`agent/src/memory.ts` puts it into the instructions. Personality is tone guidance
under the base tool and file rules. Profile and facts are personal context.

The prompt stays fixed through the run's tool loop and counts toward every
context estimate. The next run, in any session, reads fresh memory. Memory is
shared by every session and provider in one data directory.

`context-file.ts` reads `soul.md` and `profile.md` from the data directory. A
missing file is empty, and Poppet never creates one. A missing, empty, or
whitespace-only `soul.md` keeps the default personality. Reads reject symlinks,
non-regular files, invalid UTF-8, and NUL bytes. An oversized or invalid file or
facts block fails the run before the provider is resolved. Empty memory leaves
the base instructions unchanged.

## Memory tool

`poppet_memory.memory` is offered to interactive runs with tool-capable models:
CLI chat, web chat, and gateways. It has a fixed object schema with `action`
(`remember`, `replace`, or `forget`), `key`, and nullable `value`. The decoder in
`memory-tools.ts` checks the action-specific rules and rejects extra properties.
`forget` needs `value: null`. `remember` never overwrites an existing key. There
is no list action, because facts are already in the instructions.

- The host sets `sourceRunId` to the active run. The model cannot supply it.
- Before writing, the agent checks the next snapshot against the facts budget.
- The result is a short acknowledgement, not the value.
- The change shows up in the next run's snapshot. The current prompt stays as it
  was.

The instructions allow a change only on an explicit request in the owner's
current message. The model judges intent. There is no keyword scanner and no
extra confirmation step. Profile, personality, skills, history, and tool results
never grant permission. The tool cannot edit `profile.md`, `soul.md`, or
credentials.

The tool journal records each call before dispatch. Under graceful cancellation,
a started change finishes together with its saved result. A storage failure, or
a committed change whose result could not be saved, stays uncertain and is never
replayed. A completed change survives a later failure in the run. Forgetting a
fact does not redact earlier messages or tool records.

Scheduled runs keep their starting snapshot but never get the tool. The
`origin: "scheduled"` policy removes it, and a fabricated call fails the normal
permission check. A task keeps state between runs with a
[task note](tasks.md#task-notes) instead. Attachments and untrusted content also
withdraw the tool. See [chat](chat.md#untrusted-content).
