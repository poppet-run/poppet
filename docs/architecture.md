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

## Messaging gateway

`conversation-naming.ts` owns rename reconciliation and owner-override handling.

Discord and Slack thread chat and Telegram chat are bundled. Additional adapters can be loaded from explicitly
configured installed packages.
The gateway runs
inside the neutral worker host, with scheduling optional, and shares its store, memory, model
resolver, and `Agent` request slots with CLI, web chat, and scheduled requests. The
CLI composes these scoped services and preserves existing worker commands and
local IPC. No second process acquires SQLite, and messaging connections do not
expose the local command socket to the network.

Scheduled task delivery uses the same durable reply queue. The host supplies
`TaskDestinations` to resolve explicit conversation selections through enabled
gateways. Each task and occurrence saves a `DeliveryDestination` containing the
adapter, account, owner, scope, parent, and conversation identity. The gateway
reconciles completed occurrences into completed inbox entries without creating
bindings or model requests. A unique occurrence/run index makes this idempotent;
queue insertion and chunk creation commit together. A failed occurrence with a
destination is reconciled the same way into a fixed notice naming the task and
the run's reason code, never model output or error text. Its inbox entry uses the
synthetic run ID `notice:<occurrence-id>:<finished-at>`, since a failure may have
no run, a retry reuses the occurrence ID, and queued results of unfinished runs
are rejected. A failure directly after another failure of the same task is
recorded with no chunks, and failures that finished over 24 hours ago are
ignored, so each streak posts once and an upgrade posts no history. A no-reply answer saves its
inbox entry with no chunks, so it is reconciled once and nothing is sent. The normal delivery loop
rechecks current policy and adapter permissions and preserves bounded retries
and uncertain-send handling. Delivery status never changes execution status.

Quiet hours are decided when a chunk is about to send, not when it is queued, so
nothing about the window is stored. `quietHoursEnd` in `@poppet/config` returns
the end of the window containing an instant, or null; any sender of scheduled
output uses it. While it returns a time, the delivery query sorts chunks of
scheduled entries last, so replies keep flowing; when only scheduled chunks remain,
the loop leaves them pending without an attempt and logs the hold once per window.
The loop's existing one-second fallback wake sends them after the window ends.
`TaskDeliveries` reports `heldUntil` from the same function.

### Package boundaries

The `@poppet/gateway` package owns validated incoming messages,
authorization, conversation-to-session mapping, durable message acceptance, and
reply delivery. `@poppet/gateway-discord` owns Discord credentials, Gateway
connections, event decoding, mentions, thread operations, formatting, and rate
limits. External adapters implement the same small contract. The CLI owns
adapter registration and live layer composition; neither the agent nor task
scheduling imports concrete messaging adapters. `@poppet/gateway-slack` owns Slack
Socket Mode, Web API calls, file downloads, reactions, setup, and credentials.

The shared contract carries the adapter and bot account identity, external
message and conversation IDs, sender ID, text, and reply destination. Keep
platform IDs as opaque strings. Adapters expose scoped incoming events and text
delivery, typing, and message-status operations; add other capabilities only when implemented. Messaging is
independent of inference providers, so a channel can use any configured provider
that supports the selected model. Call the typed agent interface directly
and consume completed runs rather than parsing CLI stdout or stderr.

`GatewayRegistration` in `@poppet/gateway` defines identity, setup help, setup,
and lazy loading. The CLI registry is `apps/cli/src/commands/gateway/registry.ts`; it is the
only CLI module importing a concrete gateway package. The generic host generates
help, dispatches setup, and composes each configured gateway with its own gateway
instance. Gateways share the store, repository, and agent permit. A fresh gateway
layer per registration keeps message streams, authorization, and sessions isolated.

The host provides only `GatewayEnvironment.dataDirectory` and bounded secret input
through `GatewayInput`. Adapters own argument schemas, credential handling,
setup messages, optional interactive `promptSetup`, and platform loading. Configuration
inspection returns either no configured layer or a layer that connects only when built. Discord and Slack expose
lightweight registration entries and load their SDKs lazily. Telegram calls the Bot API
with `fetch` and loads its adapter module lazily.
Existing setup commands and settings files are unchanged.

`worker status` reports messaging connection state and configuration errors in a `channels`
array, with enabled state and persisted queue/delivery totals at the top level.
Totals are read once from the shared repository. Configuration failures remain
isolated to their registration, and stopped status does not build connections.
Tests append fake registrations and exercise setup, help, simultaneous message
handling, separate sessions, shared request limits, status, and resource cleanup.

Channel packages own protected credential storage, separate from model-provider
credentials and memory. Reuse compatible protection and locking helpers
without treating a Discord bot token as a model-provider connection. Tokens stay
out of logs, command output, launch arguments, and LaunchAgent environment data.
Persist non-secret channel settings so the installed worker can load them.

Discord authorization lives in `config.json`; the protected `channels/discord.json`
contains only the token. Discord supplies the bot identity after authentication.
Interactive setup masks token input; direct setup accepts explicit flags. Setup
merges ordinary settings atomically under ownership locks. Loading settings does
not rewrite either file.
The worker reads both files at startup. discord.js 14.27.0 owns Gateway
heartbeats, reconnect/resume, and Discord API encoding. Ambiguous REST failures
are not automatically retried by the SDK. Adapter failures stay in connection
status, leaving the local CLI and scheduler available.

### Slack threads

Slack uses an outbound Socket Mode connection and the Web API, with no public
webhook. Ordinary policy lives under `slack` in `config.json`; the protected
`channels/slack.json` stores bot and app tokens. One owner and workspace are
allowed. Accessible unshared channels are supported; shared channels and DMs are
rejected. Mentions start thread sessions and attached threads accept follow-ups
without a mention. See [Slack setup](gateways/slack.md).

The adapter supplies authenticated, bounded downloads from Slack's file host and
progress reactions. `/new`, `/status`, `/cancel`, `/approve`, and `/deny` use the
shared gateway text-control path. Approval prompts carry Block Kit buttons that
arrive as Socket Mode interactive events. Slack supplies no typing
indicator or remote thread naming. Scheduled destinations use a channel ID or
`<channel-id>:<thread-timestamp>` and the same durable result and failure-notice
queue as Discord.

### Discord threads as sessions

The Discord adapter supports text conversations across one configured server,
restricted to one configured user ID. Its home channel is the default destination
for proactive messages. The flow is:

1. An actual mention of the bot ID in an accessible text channel starts a thread from
   that message. Its text becomes the first input in a new Poppet session.
2. A mention from the configured user inside an accessible thread attaches a session
   if needed. It never creates a nested thread or
   imports unrelated history.
3. Subsequent messages in that thread continue the same session unless the owner
   explicitly starts a fresh session with `/new`. Follow-ups in an attached thread
   do not require a mention.
4. Replies remain in the thread. A different thread starts a separate session;
   an existing binding retains its saved provider and model.

Persist a unique binding from adapter, bot account, guild, and thread IDs to the
Poppet session ID. Keep the initiating message ID for thread-creation recovery.
Renaming or archiving a thread does not reset its session. If Discord no longer
permits access or delivery, preserve the local history and report the failure
locally instead of sending the answer to another channel. A new thread is the
normal way to start a fresh conversation; `/new` can replace the active binding
without deleting earlier history.

Use an outbound Discord Gateway connection; no public webhook is needed. Enable
the Message Content intent for follow-ups without mentions, validate the required
channel/thread permissions, and report missing access clearly. Restrict startup
to the configured guilds and channels, match mentions by bot ID rather than
display name, and ignore bot and webhook messages. Send completed text replies,
split to Discord's limits, with automatic mentions disabled. Refresh Discord's
typing indicator while the agent works; stop on completion, failure, or
cancellation, and keep indicator failures separate from request execution.
Mark the original message with 👀 while processing and replace it with ✅ after
a successful run. Failures and cancellation clear the bot's 👀 without marking
success. Reactions are best effort and do not change durable execution or delivery;
crashes and network errors may leave stale markers. Image and text-file attachments
use bounded adapter downloads and the shared agent validation and storage path.
Progressive edits, voice, DMs, and forum-specific behavior are deferred.
See Discord's [thread permissions](https://docs.discord.com/developers/topics/threads#permissions)
and [message content rules](https://docs.discord.com/developers/events/gateway#message-content-intent).

Authorization applies to every incoming message and control command before
creating a session or invoking the model. A status or cancel command is scoped to
the current thread's session and the allowed user. Keep personal memory and conversation content
available only in channels the owner has explicitly chosen for that context.
Threads inherit parent-channel visibility: sender authorization does not make
replies private. Start in an owner-controlled private channel. Supporting other
users or shared channels requires an explicit memory and tool-access policy;
separate sessions alone do not isolate the current shared profile or facts.

### Acceptance, execution, and delivery

The store schema includes conversation bindings, accepted message IDs,
and delivery records. The gateway owns their repository through the shared
`SqlClient`; the store retains database ownership and migration history.
Deduplicate by adapter, bot account, and external message ID. Persist accepted
work before acknowledging receipt where the platform provides such a mechanism. Bound pending work and reject overload
clearly. Preserve message order within each conversation: the inbox query
offers an entry only when no earlier entry in its conversation is queued or
executing.

Link accepted inputs to their session and run durably before execution can
produce side effects. Reconnects must not create duplicate threads, sessions, or
runs. Recover thread creation by inspecting the initiating message's thread;
uncertain external operations require reconciliation, not blind replay. Queued
inputs that have not started may resume after restart. Runs that started and
were interrupted retain the store's existing no-replay rule and require an
explicit new request. Cancellation interrupts only the owned queued or active
requests and releases their agent permits; requests in other conversations continue.

Save completed answers before delivery. Record destination, run, chunk order,
delivery state, and returned platform message IDs so reply failures never rerun
inference or tools. Honor rate limits and retry known safe failures with bounded
backoff. A lost send acknowledgement may mean Discord already posted the reply;
record uncertain delivery for reconciliation rather than claiming exactly-once
external delivery or blindly resending it. Channel disconnects do not cancel
already accepted agent work. Worker shutdown finalizes active runs and preserves
pending delivery records. Isolate adapter reconnect failures so CLI access and
scheduled work remain available; storage failures still stop unsafe execution.
Status exposes connection state, pending work, and failed or uncertain delivery
without logging chat content or secrets.

The schema includes bindings, inbox records, and ordered reply chunks. The
gateway reserves a run ID before execution and supplies it to `Agent.send` and
the store. Stable session IDs recover a crash between session creation and
thread binding. Recovery inspects the saved run before deciding whether an
accepted input never started or already completed/interrupted. The worker's messaging
dispatcher claims each eligible entry atomically (`queued` to `executing`) and
runs it in a fiber set owned by the gateway run, up to `chat.maxConcurrentRequests`
at once; an independent loop delivers replies. Each finished request wakes the
dispatcher so the next entry in its conversation starts. Scheduled runs and CLI
chat compete for the same agent slots; the gateway reserves none. Worker shutdown
interrupts every active request and leaves it `executing` for recovery. Pending inputs are capped at 64 per bot account.

Discord's Gateway has no application-level acknowledgement tied to SQLite.
Incoming events use a bounded in-memory queue before acceptance, with dropped
and rejected counts in local status. Session history and accepted inputs survive
restart; delivery of events lost before acceptance or after an unrecoverable
disconnect is not guaranteed. `worker status` reports persisted pending, failed,
and uncertain delivery counts even when the worker is stopped. Thread-scoped
`@Poppet /status` and `@Poppet /cancel` are text controls rather than registered
slash commands.

### External adapters

The CLI loads default `GatewayRegistration` exports listed in `gatewayPackages`
from `<POPPET_DATA_DIR>/gateways`. Discord, Slack, and Telegram remain bundled. See
[adding a gateway](development.md#adding-a-gateway) for setup and compatibility.

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

## Conversation naming

The gateway's channel naming capability returns creation ownership,
reads current names, and conditionally renames managed conversations. Bindings
retain source-message provenance, the last confirmed name, pending update, and
last title considered. The gateway considers only successfully delivered answers
for optional inference. External edits disable synchronization, and uncertain
acknowledgements are reconciled without a second remote mutation. The Discord
adapter owns SDK calls, permissions, platform name limits, and error mapping;
other adapters can omit the capability. Inference-provider packages are unchanged.
