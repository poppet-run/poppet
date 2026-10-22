# CLI command modules

[Refactoring plans](index.md)

## Goal

Split `apps/cli/src/cli.ts` (about 1,000 lines) so each command area lives in
its own module. `makeCLI` should only assemble the command tree.

## Current state

Almost everything is inside one `makeCLI` closure (lines 127–1010). It defines:

- Shared helpers: `runtime` (`runtimeLayers(registered)`), `startWorker`, and
  `throughWorker`.
- Runners: `runAuth`, `runMCP`, `runMemory`, `runWorkerCommand`, `runTasks`, and
  `runChat`.
- Command trees: `auth` (generated per provider), `chat`, `memory`, `tasks`
  (about 230 lines), `gateway`, `worker`, plus inline `config`, `store`, `mcp`,
  `web`, `provider`, `projects`, and `skills`.

`cli.test.ts` drives everything through `makeCLI(...)` with injected writers,
worker manager, channels, and line reader.

## Design

Put the closure's shared state into a context object built once in `makeCLI`:

```ts
// apps/cli/src/commands/context.ts
export interface CLIContext {
  readonly registered: ReadonlyArray<ProviderRegistration>;
  readonly channels: ReadonlyArray<ChannelRegistration>;
  readonly runtime: ReturnType<typeof runtimeLayers>;
  readonly write: ChatWriter;
  readonly writeThinking: ChatWriter;
  readonly readLine: typeof readChatLine;
  readonly worker: typeof manageWorker;
  readonly startWorker: (mode: WorkerMode) => Effect.Effect<…>;
  readonly throughWorker: <E>(…) => Effect.Effect<…>;
}
```

Each module exports a function from `CLIContext` to its command, for example
`tasksCommand(context)`. The module holds both the command tree and its runner.

| Module                                | Contents                                                          |
| ------------------------------------- | ----------------------------------------------------------------- |
| `commands/auth.ts`                    | `runAuth`, provider help, per-provider `auth` commands            |
| `commands/chat.ts`                    | `runChat`, `chat` tree                                            |
| `commands/memory.ts`                  | `runMemory`, `memory` tree                                        |
| `commands/tasks.ts`                   | `runTasks`, `tasks` tree, task flags                              |
| `commands/gateway.ts`                 | `gateway` tree                                                    |
| `commands/worker.ts`                  | `runWorkerCommand`, `worker` tree                                 |
| `commands/misc.ts` (or one file each) | `config`, `store`, `mcp`, `web`, `provider`, `projects`, `skills` |

Shared flags (`textArgument`, `codingFlag`, `projectFlag`, `skillFlag`) move to
`commands/flags.ts`.

## Steps

1. Create `CLIContext` and build it in `makeCLI`. No commands move yet.
2. Move one area per commit, starting with the largest and most self-contained:
   tasks, chat, auth, worker, gateway, then the small ones.
3. Run `bun run check` after each move. `cli.test.ts` should not need changes,
   since `makeCLI`'s signature stays the same.

## Verification

`apps/cli/src/cli.test.ts`, `chat.test.ts`, and `mcp.test.ts` pass unchanged.
`bun run start --help` output, and the help for each subcommand, is identical
before and after. Capture it to a file first and diff.
