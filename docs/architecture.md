# Poppet architecture

[Documentation index](README.md)

The CLI runs chat locally when no worker owns the data directory. A running
worker handles CLI requests, scheduled tasks, messaging, and optional web chat
through one store connection and shared agent request slots. Requests within one
session stay ordered. Background installation supports macOS and Linux with systemd.

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

The Bun platform adapter is pinned alongside Effect. Its API is marked unstable
in Effect 4, so dependency upgrades must include the CLI checks.

## Workspaces

The Bun monorepo uses private workspaces:

| Workspace                     | Responsibility                                                                                                         | Workspace dependencies                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `@poppet/cli`                 | Process startup, commands, terminal output, live layer composition                                                     | Config, agent, MCP, memory, tasks, store, platform, gateway, gateway adapters, web protocol, provider layers |
| `@poppet/web`                 | Preact browser chat, Nanostores state, and shared web API types                                                        | None                                                                                                         |
| `@poppet/mcp`                 | Scoped stdio/HTTP clients, OAuth sign-in, bounded discovery, schema validation                                         | Credentials, I/O helpers, sign-in, provider contract                                                         |
| `@poppet/agent`               | Persisted chat, bounded context, deadlines, terminal run states                                                        | Config, I/O helpers, memory, store, provider contract                                                        |
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
| `@poppet/provider-opencode`   | OpenCode Go catalog, secret configuration, and protocol routing                                                        | Provider contract, credentials, protocol adapters                                                            |
| `@poppet/provider-openrouter` | OpenRouter catalog, model capabilities, and secret configuration                                                       | Provider contract, credentials, protocol adapters                                                            |
| `@poppet/provider-openai`     | OpenAI sign-in, credential lifecycle, model catalog, subscription inference                                            | Credentials, sign-in, provider contract, protocol adapters                                                   |
| `@poppet/sign-in`             | Browser authorization: loopback callback, pasted callbacks, deadline                                                   | Effect                                                                                                       |

The CLI lives in `apps/cli`, browser chat in `apps/web`, and libraries in `packages/`.
Each workspace owns its dependencies, TypeScript config, and colocated tests. Libraries expose explicit package exports. Imports
between workspaces use those exports. Internal imports use `#src/*` aliases,
defined in each workspace's `package.json` and mapped to `./src/*.ts`.
Provider workflow helpers and test fixtures remain internal. Bun and TypeScript
resolve these package-local aliases without extra `tsconfig` path mappings.

The root package exposes `poppet` through its `bin` entry. `bun run check`
covers formatting, linting, tooling configuration types, every workspace's types,
and all tests. The workspaces share `tsconfig.base.json` and one lockfile.

The CLI owns `runtime.ts` and selects complete provider layers from
`apps/cli/src/providers.ts`. Each provider package composes its own authentication,
credentials, and model services. The host supplies `ProviderEnvironment` with the
application name and data directory, and `CredentialInput` for terminal key input.
Providers do not depend on application configuration or other provider packages.

## Modules

See the [source layout](development.md#source-layout) for module paths. Provider
packages own authentication and inference adapters. The agent owns persisted
conversation execution, context, and built-in tools. Tasks own scheduling and
execution history; the gateway owns messaging acceptance and delivery. Their
packages define and migrate their own tables, and the CLI composes their layers
around one store connection and agent.

Each live service gets a layer at the application boundary. Tests replace model,
authentication, and clock behavior without contacting an account. SQLite and
filesystem tests use temporary directories.

Each capability's service module defines its contextual service and live layer.
Its workflow modules contain the operations, while pure helpers stay separate.
The auth layer captures login and refresh dependencies once and wraps those
operations in one shared semaphore. The sign-in service scopes the shared
`@poppet/sign-in` callback listener; the OAuth service owns cached discovery. These helpers do not add
services or layers of their own.

Tests live beside their capability modules. The provider's `src/test/fixtures/` composes injected
services with local OAuth and model servers shared by the behavior suites.

`runtime.ts` builds only the registered provider selected
for an auth or inference command. Its store layer opens SQLite for saved-data operations and worker execution.
Help, configuration, skill file inspection, and provider commands do not
open the conversation database.

## Data and execution rules

SQLite owns durable records. An Effect queue can wake a worker, but it does not
replace persisted pending runs or task occurrences. A single owner executes runs
and refreshes credentials. The neutral worker host uses the store lock and a
protected Unix socket for commands while its services are active.

Store normalized model messages, tool requests, tool results, versioned provider
continuation data, and each run's provider/model selection. Trimming context must
preserve complete exchanges, their continuation data, and tool request/result
pairs. Limit loaded memory, tool output, model turns, and tool calls. Stop clearly
when the active exchange alone exceeds the context budget.

Keep credentials separate from memory and tool-readable files. The runner
enforces allowed tools before invoking them. Scheduled runs exclude memory and
task writes. MCP offers owner-verified reads from `scheduledTools` and reviewed
actions from `scheduledReviewedTools`. The agent reviews Bash and MCP actions
against the saved prompt and fails the occurrence if human approval is needed.

Do not automatically retry a side effect whose completion is uncertain. Record
its state and require an explicit retry. Database updates use transactions. Exactly-once external execution is not assumed.

## Dependencies

The foundation uses Effect 4.0.4, its Bun platform adapter, TypeScript 7.0.2,
Oxfmt 0.75.0, Oxlint 1.90.0, and Bun 1.4.4 with Bun 1.4.4 types. Bun checks types;
TypeScript provides editor support. Versions are pinned and the lockfile is
checked in. Effect provides Config and Schema, so a separate schema
library is unnecessary.

Subscription verification adds OpenAI 7.32.0 for Responses streaming and jose
6.2.12 for JWT/JWKS validation. The official sign-in devkit was not available as
an installable package when this flow was added, so OAuth follows the documented
public-client protocol directly. Scheduled tasks use Effect Cron for five-field
expressions with explicit timezones.

References: [Effect installation](https://effect.website/docs/v4/getting-started/installation),
[services](https://effect.website/docs/v4/requirements-management/services),
[configuration](https://effect.website/docs/v4/configuration), and
[process runtime](https://effect.website/docs/v4/platform/runtime).
