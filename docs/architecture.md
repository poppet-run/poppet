# Architecture

[Engineering notes](README.md)

Poppet is one Bun process at a time per data directory. The CLI runs a command
in-process when no worker owns the directory. A running worker owns the store and
serves CLI commands over a Unix socket, and it also runs scheduled tasks,
gateways, and optional web chat. Every chat request, wherever it comes from, goes
through one `Agent` with shared request slots, and requests within one session
run in order. Login services exist for macOS and for Linux with systemd.

## Effect conventions

Use `Effect<A, E, R>` for operations with I/O, expected failures, cancellation, or
dependencies. Keep pure transformations as ordinary TypeScript functions.

- Define external capabilities with `Context.Service` and provide implementations
  with `Layer`, as `AppConfig` does. Add services when a capability
  needs injection or resource ownership.
- Validate configuration, tool arguments, and external records with Effect
  Schema. Keep expected failures in the typed error channel and distinguish them
  from defects.
- Compose operations with `Effect.gen`. Execute Effects at the process boundary
  in `main.ts` and in tests. Keep `runPromise` out of application services.
- Acquire database connections, listeners, and other resources in scoped layers
  with finalizers. `BunRuntime.runMain` owns process interruption and shutdown.
- Adapt Promise APIs with `Effect.tryPromise` and pass its `AbortSignal` to APIs
  that support cancellation. Apply local deadlines to model requests and tools.
- Apply retry policies only to operations known to be safe to repeat. Use Effect
  `Schedule` for bounded retries and polling, and a controllable clock in tests.

The Bun platform adapter and the SQL client are unstable APIs in Effect 4, so an
Effect upgrade must pass the full check.

## Workspaces

All workspaces are private. The CLI is in `apps/cli`, browser chat in `apps/web`,
and libraries in `packages/`.

| Workspace                     | Responsibility                                                                                                         | Workspace dependencies                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `@poppet/cli`                 | Process startup, commands, terminal output, live layer composition                                                     | Config, agent, MCP, memory, tasks, store, platform, gateway, gateway adapters, web protocol, provider layers |
| `@poppet/web`                 | Preact browser chat, Nanostores state, and shared web API types                                                        | None                                                                                                         |
| `@poppet/mcp`                 | Scoped stdio/HTTP clients, OAuth sign-in, bounded discovery, schema validation                                         | Credentials, I/O helpers, sign-in, provider contract                                                         |
| `@poppet/agent`               | Chat runs, context, budgets, built-in tools, and skills                                                                | Config, I/O helpers, memory, store, provider contract                                                        |
| `@poppet/io`                  | Bounded stream and subprocess I/O, shared HTTP URL and public-address validation                                       | None                                                                                                         |
| `@poppet/config`              | Validated settings and the `AppConfig` service                                                                         | Provider contract, credential locks, MCP configuration schemas                                               |
| `@poppet/credentials`         | Protected API-key and record storage, locks, and environment overrides                                                 | Provider contract                                                                                            |
| `@poppet/store`               | SQLite ownership, migrations, conversation records, and run lifecycle                                                  | Config, credentials, provider contract                                                                       |
| `@poppet/memory`              | Memory contract, local facts, bounded profile and fact snapshots                                                       | Config and store for the local implementation                                                                |
| `@poppet/platform`            | Worker actions, errors, status, launch description, bounded log reading, and LaunchAgent and systemd user unit control | I/O helpers                                                                                                  |
| `@poppet/tasks`               | Scheduling, task persistence, recovery, and task commands                                                              | Config, agent, store, worker transport, provider contract                                                    |
| `@poppet/worker`              | Protected local command transport and request lifecycle                                                                | Effect                                                                                                       |
| `@poppet/gateway`             | Authorized messaging, thread bindings, durable inbox, and reply delivery                                               | Agent, config, credentials, I/O helpers, store, tasks, provider contract                                     |
| `@poppet/gateway-discord`     | Discord connections, mentions, threads, permissions, and protected settings                                            | Config, credentials, gateway contract                                                                        |
| `@poppet/gateway-slack`       | Slack Socket Mode, thread messages, attachments, permissions, and protected settings                                   | Config, credentials, gateway contract                                                                        |
| `@poppet/gateway-telegram`    | Telegram Bot API long polling, chats, forum topics, and protected settings                                             | Gateway contract                                                                                             |
| `@poppet/provider`            | Shared contracts and operations, with protocol adapters through a separate export                                      | None                                                                                                         |
| `@poppet/provider-opencode`   | OpenCode and OpenCode Go catalogs, keys, and protocol routing                                                          | Provider contract, credentials, protocol adapters                                                            |
| `@poppet/provider-openrouter` | OpenRouter catalog, model capabilities, and secret configuration                                                       | Provider contract, credentials, protocol adapters                                                            |
| `@poppet/provider-openai`     | OpenAI sign-in, credential lifecycle, model catalog, subscription inference                                            | Credentials, sign-in, provider contract, protocol adapters                                                   |
| `@poppet/sign-in`             | Browser authorization: loopback callback, pasted callbacks, deadline                                                   | Effect                                                                                                       |

Each workspace declares its own dependencies and has its own `tsconfig.json`
and colocated tests. Libraries expose explicit package exports, and other
workspaces import only those. Internal imports use `#src/*`, mapped to
`./src/*.ts` in each `package.json`, which Bun and TypeScript resolve without
`tsconfig` paths. Test fixtures stay internal. The root package exposes `poppet`
through its `bin` entry. Lint restricts concrete provider imports to
`apps/cli/src/providers.ts` and concrete gateway imports to the gateway registry.

## Composition

The CLI composes every live layer at the application boundary:

- `runtime.ts` builds only the layers a command needs. It builds only the
  selected provider, for an auth command or inside a run. See
  [command routing](cli.md#routing).
- The store layer opens one SQLite connection. Memory, tasks, the gateway, and web
  chat use its `SqlClient` and migrate their own tables. See
  [storage](storage.md).
- The host supplies `ProviderEnvironment` and `CredentialInput` to providers, and
  `GatewayEnvironment` and `GatewayInput` to gateways. Neither kind of package
  depends on application configuration or on another package of its kind.
- The worker host shares one store, agent, memory, and provider resolver across
  scheduling, gateways, and web chat. See [worker](worker.md#host).

Each capability's service module defines its `Context.Service` and live layer.
Workflow modules hold the operations and pure helpers stay separate. Tests swap
the model, authentication, and clock layers, and use temporary directories for
SQLite and files.

## Rules

Every subsystem follows these rules.

- **SQLite is the source of truth.** A queue can wake work, but it never replaces
  a saved pending run, inbox entry, or occurrence.
- **One owner.** One process owns a data directory, runs requests, and refreshes
  credentials, enforced by the [owner lock](storage.md#owner-lock).
- **Save before acting.** Inputs are saved before inference, answers before
  delivery, and tool calls before dispatch.
- **No blind replay.** A side effect whose result is unknown is saved as
  uncertain and needs an explicit retry. No model request, tool call, or send is
  retried automatically unless it is known to be safe to repeat. Exactly-once
  external delivery is never assumed.
- **Complete exchanges.** Context trimming keeps whole exchanges, with their tool
  pairs and continuation. A run fails when the active exchange alone exceeds the
  budget.
- **Bounded everything.** Memory, tool output, model turns, tool calls, request
  bodies, downloads, and logs all have limits. Configurable limits and timeouts
  are defined once in `io/src/settings.ts`. See
  [timeouts and limits](configuration.md#timeouts-and-limits).
- **Only the owner authorizes.** Tool permissions are checked before a call runs.
  Pages, MCP results, recalled history, skills, attachments, and command output
  are data and never permission. See [untrusted content](chat.md#untrusted-content).
- **Scheduled runs are restricted.** They never change memory or tasks, use only
  the scheduled MCP allowlists, and fail instead of waiting for a person. See
  [scheduled run policy](tasks.md#scheduled-run-policy).
- **Credentials stay apart.** Credentials live in `auth/` and `channels/`, away
  from memory, tool-readable files, logs, prompts, and the service environment.

## Dependencies

Versions are pinned in each `package.json` and in `mise.toml`, and the lockfile is
checked in. Effect provides Schema, Config, Cron, SQL, and the CLI framework, so
there is no separate schema or scheduling library. The CLI and packages type-check
with `@effect/tsgo`. Bun checks the web app and root tooling. See
[development](development.md#commands-and-tooling).

Other dependencies with a reason to note:

- `openai` for the Responses and Chat Completions adapters in
  `@poppet/provider/protocol`.
- `jose` for ChatGPT ID token and JWKS validation. OAuth follows the
  public-client protocol directly.
- `@modelcontextprotocol/client`, `ajv`, `ajv-formats`, and `re2-wasm` for
  [MCP](mcp.md).
- `discord.js`, `@slack/socket-mode`, and `@slack/web-api` for
  [gateways](gateways.md).
- `entities` for page reading, and `marked` for web chat.

See Effect's guides to [services](https://effect.website/docs/v4/requirements-management/services),
[configuration](https://effect.website/docs/v4/configuration), and the
[process runtime](https://effect.website/docs/v4/platform/runtime).
