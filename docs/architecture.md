# Poppet architecture

[Documentation index](index.md)

Start with one local process invoked by the CLI. Add a background worker when
scheduled tasks need one. The first chat flow calls the runner directly.

## Effect conventions

Use `Effect<A, E, R>` for operations with I/O, expected failures, cancellation, or
dependencies. Keep pure transformations as ordinary TypeScript functions.

- Define external capabilities with `Context.Service` and provide implementations
  with `Layer`. `AppConfig` is the first example. Add services when a capability
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

The Bun monorepo has seventeen private workspaces:

| Workspace                     | Responsibility                                                              | Workspace dependencies                                         |
| ----------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `@poppet/cli`                 | Process startup, commands, terminal output, live layer composition          | Config, agent, memory, tasks, store, platform, provider layers |
| `@poppet/agent`               | Persisted chat, bounded context, deadlines, terminal run states             | Config, memory, store, provider contract                       |
| `@poppet/config`              | Validated settings and the `AppConfig` service                              | Provider contract                                              |
| `@poppet/credentials`         | Protected API-key storage, locks, and environment overrides                 | Provider contract                                              |
| `@poppet/store`               | SQLite ownership, migrations, conversation records, and run lifecycle       | Config, credentials, provider contract                         |
| `@poppet/memory`              | Memory contract, local facts, bounded profile and fact snapshots            | Config and store for the local implementation                  |
| `@poppet/platform`            | Worker actions, errors, and a host-supplied launch description              | None                                                           |
| `@poppet/platform-macos`      | macOS LaunchAgent control, plist generation, and worker logs                | Platform contract                                              |
| `@poppet/tasks`               | Scheduling, task persistence, recovery, and task commands                   | Config, agent, store, worker transport, provider contract      |
| `@poppet/worker`              | Protected local command transport and request lifecycle                     | Effect                                                         |
| `@poppet/gateway`             | Authorized messaging, thread bindings, durable inbox, and reply delivery    | Agent, config, store, provider contract                        |
| `@poppet/channel-discord`     | Discord connections, mentions, threads, permissions, and protected settings | Gateway contract, credentials                                  |
| `@poppet/provider`            | Normalized messages, streams, connection services, registration contracts   | None                                                           |
| `@poppet/provider-protocol`   | Reusable Responses and Chat Completions codecs and scoped streaming         | Provider contract                                              |
| `@poppet/provider-opencode`   | OpenCode Go catalog, secret configuration, and protocol routing             | Provider contract, credentials, protocol adapters              |
| `@poppet/provider-openrouter` | OpenRouter catalog, model capabilities, and secret configuration            | Provider contract, credentials, protocol adapters              |
| `@poppet/provider-openai`     | OpenAI sign-in, credential lifecycle, model catalog, subscription inference | Provider contract, protocol adapters                           |

The CLI lives in `apps/cli`; libraries live in `packages/config` and
`packages/provider-openai`, `packages/provider`, `packages/provider-opencode`,
`packages/provider-openrouter`, `packages/provider-protocol`, `packages/credentials`,
`packages/store`, `packages/agent`, `packages/memory`, `packages/tasks`,
`packages/platform`, `packages/platform-macos`, `packages/worker`, `packages/gateway`, and
`packages/channel-discord`.
Each workspace owns its dependencies, TypeScript config, and colocated tests. Libraries expose explicit package exports. Imports
between workspaces use those exports. Internal imports use `#src/*` aliases,
defined in each workspace's `package.json` and mapped to `./src/*.ts`.
Provider workflow helpers and test fixtures remain internal. Bun and TypeScript
resolve these package-local aliases without extra `tsconfig` path mappings.

Root scripts preserve `bun run start`, `bun run dev`, and `bun run check`.
Start and dev run the CLI without changing the working directory. Root checks
cover formatting, linting, tooling configuration types, every workspace's types,
and all tests. The workspaces share `tsconfig.base.json` and one lockfile.

The CLI owns `runtime.ts` and selects complete provider layers from
`apps/cli/src/providers.ts`. Each provider package composes its own authentication,
credentials, and model services. The host supplies `ProviderEnvironment` with the
application name and data directory, and `CredentialInput` for terminal key input.
Providers do not depend on application configuration or other provider packages.

## Modules

The implemented modules below live under `packages/provider-openai/src`, except
configuration in `packages/config/src` and CLI files in `apps/cli/src`.
Shared provider types live in `packages/provider/src`, and Go routing lives in
`packages/provider-opencode/src`. OpenRouter discovery and composition live in
`packages/provider-openrouter/src`. SQLite storage lives in `packages/store/src`.
Persisted chat lives in `packages/agent/src`. Notes tools and their sequential model loop are implemented in that workspace.
The memory contract and local implementation live in `packages/memory/src`.
The agent formats memory snapshots into model instructions. Task scheduling, persistence,
recovery, and task command execution live in `packages/tasks/src`. The protected
worker transport lives in `packages/worker/src`. The CLI keeps task argument
parsing, JSON presentation, and neutral worker startup in `worker-host.ts`.
Task tables remain in the shared store migrations.

| Module                  | Responsibility                                                              | Dependencies                                      |
| ----------------------- | --------------------------------------------------------------------------- | ------------------------------------------------- |
| `config.ts`             | Validate settings and provide `AppConfig`                                   | Effect Config and Schema                          |
| `connection.ts`         | Credential schemas, redacted tokens, typed connection errors                | Effect Schema and Data                            |
| `auth/credentials.ts`   | Atomic credential replacement and exclusive owner lock                      | Configuration, scoped filesystem access           |
| `oauth/`                | OAuth service with discovery, HTTP, token, and identity modules             | Fetch, Effect Schema, jose                        |
| `sign-in/`              | Sign-in service with one-use callback and browser modules                   | Scoped Bun listener and subprocess                |
| `auth/`                 | Auth service with login, refresh, and pure state modules                    | Configuration, sign-in, OAuth, credential storage |
| `model/`                | Model service with SDK adapter, stream collector, and verification protocol | Authentication, OpenAI client                     |
| `store/`                | Scoped SQLite ownership, migrations, sessions, messages, and runs           | Configuration, shared provider schemas            |
| `agent/service.ts`      | Persisted chat, deadlines, cancellation, run finalization                   | Model resolver, store, conversation workflow      |
| `agent/conversation.ts` | Sequential model/tool loop, permission checks, run budgets                  | Model, store, notes, chat settings                |
| `agent/reply.ts`        | Validated stream completion and output limits                               | Shared model contract                             |
| `agent/context.ts`      | Complete-exchange context assembly and size limits                          | Shared message and record types                   |
| `agent/settings.ts`     | Validated context, history, and output budgets                              | Effect Config and Schema                          |
| `agent/skills.ts`       | Explicit local procedure loading with bounded filesystem access             | Config and shared snapshot schema                 |
| `agent/notes.ts`        | Note schemas, bounded filesystem access, atomic replacement                 | Config, chat settings, scoped filesystem access   |
| `agent/memory.ts`       | Run-start snapshot loading and model instructions                           | Memory service, chat settings                     |
| `memory/`               | Memory contract, local fact operations, bounded profile reads               | Effect; config and shared database for local I/O  |
| `tasks/scheduler.ts`    | Persisted due occurrences and sequential worker                             | Store, agent, clock, occurrence calculator        |
| `cli.ts`                | Typed commands and terminal presentation                                    | Application services required by each command     |

Each live service gets a layer at the application boundary. Tests replace model,
authentication, and clock behavior without contacting an account. SQLite and
filesystem tests use temporary directories.

Each capability's service module defines its contextual service and live layer.
Its workflow modules contain the operations, while pure helpers stay separate.
The auth layer captures login and refresh dependencies once and wraps those
operations in one shared semaphore. The sign-in service scopes the callback
listener; the OAuth service owns cached discovery. These helpers do not add
services or layers of their own.

Tests live beside their capability modules. The provider's `src/test/fixtures/` composes injected
services with local OAuth and model servers shared by the behavior suites.

Configuration, connection, credential, OAuth, sign-in, auth, model, and CLI
modules are implemented. `runtime.ts` builds only the registered provider selected
for an auth or inference command. Its store layer opens SQLite only for store
and chat and memory commands. Chat, notes tools, and explicit memory are implemented;
scheduling remains planned.

## Explicit local skills

`Skills` in the agent package loads one validated `SKILL.md` or lists local skill
directories. The CLI composes `SkillsLive` with host configuration. It does not
add a model tool or extend notes access. Creation requests carry only the selected
name; the process owning the store resolves it, including worker chat and task
commands. Missing or invalid selections fail before creating a session or task.

The shared store schema defines the bounded name/content snapshot. Migration 10
adds nullable snapshots to sessions and jobs. Task execution copies the saved
snapshot into each occurrence session without filesystem access. The agent adds
one saved snapshot to the run's instructions, below base rules, and the existing
context budget accounts for its serialized bytes. Tool dispatch and scheduled
read-only restrictions stay in the conversation workflow. Provider packages need
no skill-specific behavior. See [skills](skills.md).

## Provider interface

The shared interface is implemented before durable conversation storage so
its schema can preserve normalized messages and provider continuation data.
The agent depends on `ModelResolver`, supplied by the CLI runtime, and calls the
resolved model through the shared contract. `provider models` and
`provider verify` also exercise this boundary.

| Workspace                     | Responsibility                                                                |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `@poppet/provider`            | Shared inference, connection, registration, and message contracts             |
| `@poppet/provider-protocol`   | Reusable wire codecs, validated completion, deadlines, and cancellation       |
| `@poppet/provider-openai`     | ChatGPT authentication, OpenAI request translation, streams, and continuation |
| `@poppet/provider-opencode`   | OpenCode Go credentials, discovery, per-model protocol selection, and streams |
| `@poppet/provider-openrouter` | OpenRouter credentials, catalog capabilities, and Chat Completions binding    |
| `@poppet/cli`                 | Provider/model configuration and composition of the selected live layer       |

OpenRouter reuses the Chat Completions adapter in `@poppet/provider-protocol`.
It discovers concrete text models publicly and loads an environment or saved API key
only when inference begins. Catalog parameters determine each model's supported
settings. Requests require parameter support, disable provider fallbacks, and
send a stable session ID. Continuation preserves structured reasoning deltas in
arrival order, including signatures and opaque provider metadata.

Auth commands accept an explicit provider or default to `POPPET_PROVIDER`.
ChatGPT uses its existing OAuth services. API-key providers use the shared
credentials workspace, which stores versioned provider-specific files under
`<data directory>/auth` and returns redacted keys. Environment overrides take
precedence. Login supports hidden terminal input and explicit stdin input;
status and logout operate on only the chosen provider. Key persistence does not
claim remote access, which verification checks separately.

The agent owns context assembly, tool validation and execution, budgets, and run
persistence. Provider adapters own authentication, HTTP requests, protocol
translation, and stream completion. The agent imports shared contracts without
importing a concrete provider or its SDK types.

The contract uses Effect for discovery and model resolution, and Stream
for inference. Supporting types belong in `@poppet/provider` and use Effect
Schema wherever configuration or external data needs validation.

```ts
interface ProviderOperations {
  readonly models: Effect.Effect<ReadonlyArray<ModelDescription>, ProviderError>;

  readonly resolve: (modelId: string) => Effect.Effect<ModelOperations, ProviderError>;
}

interface ModelOperations {
  readonly description: ModelDescription;

  readonly stream: (request: ModelRequest) => Stream.Stream<ModelEvent, ProviderError>;
}

export class Model extends Context.Service<Model, ModelOperations>()("poppet/Model") {}
```

`resolve` validates and binds a provider/model selection. The agent resolves
the session's saved selection and calls `model.stream(request)` for each model turn.
Keep discovery and connection commands separate from the agent's inference
dependency. Authentication flows remain provider-specific.

### Provider registration and ownership

`ProviderRegistration` contains an ID, display name, authentication capabilities,
help text, and a layer supplying the shared `Provider` and `ProviderConnection`
services. `ProviderConnection` exposes login, secret-free status, logout, and
verification. Logout deletes the selected provider's persisted connection details.
For ChatGPT this includes the registration and host ID; status never recreates them.
Externally supplied environment keys remain under the host shell's control. Login returns provider-owned guidance; verification returns the
verified model ID. Provider-owned verification can record subscription metadata.
The CLI uses these services for every auth command, including normalized model
listing through `Provider.models`.

Provider IDs are bounded, path-safe strings, not an enumeration of installed
providers. Configuration receives registered IDs and the default from the host;
the first registration is the default. Unknown selections fail before provider
resources are opened. The store validates IDs and preserves continuation data
without needing the corresponding provider installed. Model descriptions expose
capabilities; HTTP protocol selection stays inside provider implementations.

To add a provider:

1. Create a workspace package exporting a `ProviderRegistration`. Implement the
   shared inference and connection services and compose their live dependencies
   inside the package. The layer may require `ProviderEnvironment`; login may
   request terminal input through `CredentialInput`.
2. Register that export in `apps/cli/src/providers.ts` and declare its workspace
   dependency in the CLI's package manifest. Run `bun install` to update workspace
   links and the lockfile.

Shared contracts, configuration, credentials, storage, and command routing need
no provider-specific edits. API-key providers can reuse `makeApiKeyConnection`
and `loadApiKey` by supplying their own ID and environment-variable name.
Concrete provider imports are restricted by lint to the registration list.
Shared protocol helpers accept extensions rather than importing providers.

### Shared request and response types

- `ModelDescription` contains provider ID, model ID, display name, and supported
  capabilities. Tool support and accepted generation settings belong to each
  model. Represent unavailable metadata explicitly and reject unsupported
  settings before inference.
- `ModelRequest` contains a stable session ID, instructions, ordered conversation
  history, tool definitions, and validated generation settings.
- Conversation history supports user text, assistant text, tool calls, and tool
  results. Preserve call IDs and output order. Tool definitions carry names,
  descriptions, and argument schemas; adapters translate their wire format.
- `ModelEvent` initially supports text deltas and a completed response containing
  authoritative ordered output, tool calls, finish reason, and optional usage.
  Expected failures use the stream's typed error channel.
- `ProviderError` distinguishes authentication, permission, quota, rate limiting,
  temporary failure, invalid request, context limits, and interrupted inference.
  Include safe provider error codes and request IDs when available. Keep
  provider-specific sign-in and credential-storage errors in their own services.

The adapter emits completion only after the protocol confirms a successful
terminal response. Missing completion, failed responses, and incomplete streams
must fail even when text or tool arguments have arrived. The agent executes tools
only from a completed response after argument and permission validation. Partial
tool arguments never authorize execution.

Each adapter scopes its active request and closes it on failure, interruption, or
early stream-consumer termination. Propagate cancellation to the underlying
request and enforce deadlines. Model requests are not automatically retried.

### Continuation and selection

Store a versioned, provider-owned continuation payload alongside normalized
assistant output. It preserves data needed for later requests, such as encrypted
reasoning and protocol-specific response items. Only the matching adapter
interprets this payload. Validate its version and provider/model identity; keep
credentials out of transcripts and continuation data.

Environment configuration includes `POPPET_PROVIDER` and `POPPET_MODEL`.
Use `openai-chatgpt` for the existing subscription connection and `opencode-go`
for OpenCode Go. Reserve `openai-api` for later API-key support.
An explicit model is required for provider verification and new chat sessions.
Help, configuration, and connection commands remain usable before selection.
Credentials stay in separate
protected storage or provider-specific secret environment values and never
appear in printable application settings.

The CLI builds only the selected provider's live dependencies. Resolve the
selection at run start and record it with the run. Keep it fixed through every
tool round trip. Configuration changes affect new sessions. Resumed sessions
retain their saved provider/model/workload because continuation data may not be portable.
Do not silently fall back to another provider or model.

### Adapter requirements

The OpenAI adapter keeps the existing ChatGPT credential lifecycle and exposes
general inference through the shared contract. Subscription inference uses
streamed Responses requests with `store: false`. Preserve completed output items
by index when the terminal snapshot omits them, along with the complete tool and
reasoning history required for continuation.
[OpenAI inference requirements](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

OpenCode Go uses an API key and documents Responses, Chat Completions, and
Anthropic Messages endpoints depending on the model. Its adapter selects the
protocol per model and sends a Poppet user agent and a stable
`x-opencode-session` conversation ID. Start with an explicit supported
model/protocol set and expand it as each protocol passes validation. OpenCode Go
specifies coding-agent traffic; resolve its suitability for Poppet's general notes
and scheduled-assistant workloads before enabling it for those uses.
[OpenCode Go requirements](https://opencode.ai/v2/docs/console/go/)

The first Go model set is `gpt-6-luna` using Responses and `glm-5.3` using
Chat Completions. Only these models are listed from the remote public catalog;
unrecognized models and Messages protocol models are rejected. The key is read
from `POPPET_OPENCODE_GO_API_KEY` only when inference begins. Go requests require
`workload: "coding"`; general assistant tasks fail before credentials are read.

The reusable protocol adapters in `@poppet/provider-protocol` bind a model
description and a supplied client Effect. Both providers reuse Responses parsing;
Go also uses Chat Completions parsing. Provider packages supply request headers,
error classification, and reasoning-continuation extensions. The shared adapters
never branch on provider IDs or open a ChatGPT
credential store. The contract package imports no SDK types.

Responses continuation retains validated output items, including encrypted
reasoning. Go owns `reasoning_content` continuation; OpenRouter owns its structured
reasoning sequence. Normalized
assistant output retains text and ordered tool calls. Each assistant message owns
its continuation. Adapters reject mismatched provider/model/version/protocol data.

A scoped abort controller and an Effect clock enforce a 60-second absolute
inference deadline. Consumer termination aborts the request before awaiting the
iterator's cleanup, so a pending network read cannot block cancellation. SDK
retries are disabled. Shared adapter tests use injected HTTP responses and a test
clock; phase 1 live evidence and future live Go checks are separate.

## Conversation store

`@poppet/store` exposes a scoped `Store` service through `StoreLive`. The CLI
provides configuration through its store runtime layer; `store status` migrates the
schema and reports counts without opening authentication services.

`database.ts` protects `<data directory>/store`, acquires the process ownership
lock, and opens Bun SQLite with strict bindings, foreign keys, WAL, and full
synchronous commits. Scope finalizers close SQLite before releasing ownership.
Database files and WAL sidecars use owner-only permissions.

`migrations.ts` owns append-only numbered SQL migrations and a ledger containing
names, checksums, and application times. It checks the application ID and schema
version, validates all applied ledger entries, and applies every pending step
inside one immediate transaction. A failed migration preserves the previous
schema and ledger. Changed history and future schema versions require an explicit
migration decision rather than silent repair.

`schema.ts` defines session, message, run, and terminal-outcome records with
Effect Schema. Migration 3 adds persisted workloads, defaulting legacy records to
`assistant`. `service.ts` binds provider/model/workload selection to sessions and runs,
validates persisted messages and completion payloads, and checks continuation
identity. SQLite foreign keys enforce record ownership and a partial unique
index permits only one pending or running run.

`queueRun` persists its pending run and input messages in one transaction.
`startRun` accepts only pending work. Pending work can fail or be interrupted;
successful completion requires a running run. `appendMessages` preserves exchanges inside
a running run. `finishRun` atomically saves a successful response and assistant
message, or records a failure/interruption reason. Read methods retain message
order and provider continuation. No raw SQLite handle is exported publicly.

A new owner marks unfinished runs interrupted with `process-exit`, preserving
their inputs without replaying them. A hard crash may leave the ownership lock;
dead-process ownership recovery uses the shared scoped lock helper. Credentials, facts, jobs, context
assembly, and model execution are outside this store's record APIs.

## Persisted chat

`AgentLive` captures `Store`, `ModelResolver`, and validated `ChatSettings`.
One scoped semaphore serializes interactive and scheduled request streams,
including persistence and provider cleanup. Waiting consumers can be cancelled
before creating a run.
Its `send` stream first saves the input and starts a run, then resolves the
session's provider/model. The CLI supplies a resolver that builds only that
registration inside the stream scope. Provider resources, including credential
locks, remain alive through the request and close on completion or interruption.
Listing sessions and inspecting history require only the store layer.

Context uses completed runs and excludes failed/interrupted inputs. Imported
exchanges with no run are validated as complete message sequences. History is
trimmed at exchange boundaries, preserving tool request/result pairs and opaque
continuation together. The newest input must fit by itself or the run fails with
`context-limit`. Settings bound context bytes, history turns, and requested output
tokens. Advertised model capacity further limits input and output. The UTF-8 size
estimate is not an exact tokenizer, and trimming never changes stored history.

Tool-capable models receive the three notes tools and conversation search. The conversation workflow
validates complete tool requests, records them, executes sequentially, and
continues with the saved results. Models without tool support receive no tools.
Text deltas stream immediately; terminal-only text or an unstreamed final suffix
is emitted before committing the answer. The source must end cleanly after one
validated completion matching the session identity. Malformed, missing, duplicate,
or trailing events fail. Text is capped at 128 KiB and serialized completion at
1 MiB. A 90-second absolute deadline includes provider resolution and streaming;
provider adapters retain their own 60-second inference deadlines.

Run finalizers record provider/agent/store failure categories or interruption.
Only completed inference becomes a saved assistant message, atomically with its
result. Stopping consumption or cancelling a request saves no partial answer.
Failed inputs remain visible in `chat show` but are not retried implicitly.
Inspection omits provider continuation while retaining normalized output, usage,
and run failure reasons. Tool results, profile content, and saved facts each have
separate content budgets.

## Notes and tool execution

`conversation.ts` captures the store, notes service, and chat budgets. It keeps
one model instance throughout each run. `reply.ts` forwards text but emits a
completion only after clean source termination and validates continuation,
finish reason, output limits, and agreement with streamed text. Complete tool
requests pass through the shared contract; no SDK types enter the agent.

The loop advertises only allowed tools, validates the whole batch, and requires
another model turn before performing side effects. Default budgets are eight
model turns, sixteen calls, and 16 KiB per tool result. Current-run messages are
never trimmed independently of their tool pairs. Definitions and tool results
count toward the context estimate; overflowing the current exchange fails clearly.
Recorded usage sums all model turns when complete usage data is available.

`notes.ts` defines argument schemas, tool descriptions, and the scoped `Notes`
service. Filesystem access begins only when a tool executes, so inspection and
text-only requests do not create the notes directory. Paths must resolve within
the configured root, with checked directories and no-follow file opens. Symlinks,
hard-linked files, non-regular files, and unsupported extensions are rejected.
Read and search I/O is bounded. Search treats its query as literal text.

Saves create checked parents, write a protected temporary file, sync it, verify
the parent again, atomically rename it, and sync the directory. The agent keeps
this save and its durable result recording uninterruptible during graceful
shutdown. An abrupt crash can still separate a write from result persistence.

Migration 4 adds `tool_calls`. Store methods atomically record an assistant tool
request with pending calls and a completed tool result with its transcript
message. The state progresses from pending to running to completed or failed.
Run failure/reopening interrupts pending calls and marks remaining running calls
uncertain. Completed calls are immutable; terminal calls cannot restart. Calls
and model requests are never replayed. `chat show` exposes the ledger for manual
inspection. An uncertain write requires checking the file before an explicit retry.

## Conversation search

Migration 9 adds an FTS5 index of completed user messages and final assistant text.
A shared SQL view defines eligibility for backfill and the run-completion trigger,
which indexes new exchanges inside the completion transaction. Tool content,
intermediate responses, failed/interrupted inputs, and continuation are excluded.
Messages remain the source of truth; current titles join from sessions at query
time. `Store.searchSessions` validates plain-text queries, quotes FTS terms, binds
parameters, and bounds ranked excerpts and serialized results.

`agent/search.ts` defines the read-only `poppet_history.search_sessions` schema.
The conversation loop dispatches it explicitly alongside notes, using the same
namespace/permission checks, durable tool lifecycle, and run budgets. Historical
text is untrusted data, not permission to act. Scheduled runs may search without
gaining note-write permission. The CLI uses the shared worker command schema and
owning store connection, with local fallback only when the worker is unavailable.
Search inspection needs neither provider credentials nor model inference. The
existing single-owner policy governs recall across CLI, task, and messaging
sessions; multiple users would need an explicit access policy.

## Explicit memory

`@poppet/memory` owns the `Memory` service, fact and snapshot schemas, and
`MemoryError`. Its operations are `snapshot`, `list`, `remember`, `replace`, and
`forget`. `LocalMemoryLive` implements these operations using the existing
`memories` table and editable `<data directory>/profile.md` and `soul.md` files.
It retains up to 128 facts of at most 4096 UTF-8 bytes each.

The store owns database acquisition and migration 5. `StoreLive` also exposes the
scoped `StoreDatabase` service, allowing the CLI to supply one connection and
owner lock to conversation storage and local memory. The memory implementation
owns fact SQL; the conversation `Store` has no memory operations or dependency on
the memory package. Existing migration checksums and persisted formats are unchanged.

The CLI manages facts through `Memory` without constructing a model provider or
requiring a model. The agent asks for one snapshot at run start, passing the chat
policy's personality, profile, and fact limits. The local implementation enforces
these limits while reading data and returns personality and profile text and keyed
values without provenance.
Context files are optional, bounded, and reject non-regular files, symlinks, invalid
UTF-8, and NUL bytes. All three budgets default to 8 KiB; exceeding them fails before
model-provider resolution. Empty memory preserves the base instructions.

`soul.md` is included as personality and tone guidance, subject to the base tool
and file access rules. Missing, empty, or whitespace-only personality files preserve
the default personality. The profile and keyed values are serialized into the
prompt as personal context. Metadata such as source runs and timestamps stays in
the store. This prompt is
kept throughout the tool loop and included in every context-size estimate. The
next run reads fresh memory even when continuing an existing session. Neither
notes tools nor chat can create or mutate facts. Forgetting affects future memory
snapshots; it does not erase prior messages or notes.

Prompt formatting and overall context limits stay in the agent. The CLI selects
the local memory layer directly; an alternate implementation can supply `Memory`
without changing the agent or command handlers. No memory-provider registry is needed.

## Current authentication flow

`CredentialStoreLive` owns the shared storage lock for an auth command's scope.
`BrowserSignIn` owns an ephemeral listener at `127.0.0.1` and releases it on
success, failure, timeout, or interruption. Shutdown drains the current response
so the browser receives the callback page. The callback consumes one attempt
and validates state before handling errors or using the code.

`OAuthClient` discovers endpoints from the fixed OpenAI issuer, validates their
origin, exchanges codes, and verifies RS256 identity tokens against JWKS. The
issued client ID is retained before exchange so a failed code can be replaced
without registering again. Verified identity must match the saved account before
credentials are replaced. An Effect semaphore serializes refresh and credential
mutations within the command; the shared ownership lock excludes other commands.

`ChatGPTModel` discovers visible account models and uses the OpenAI SDK with the
OAuth bearer token. Verification streams two requests with `store: false`, carries
complete tool and reasoning history into the second request, and records success
only after `response.completed` and a matching local tool result. It retains
`response.output_item.done` items by output index, since the final event can omit
the output array's contents. Those completed items take precedence over terminal
snapshots when rebuilding history. It does not
automatically retry model requests. The OpenAI provider resolves general inference through this
auth boundary. Subscription verification uses the shared `verifyModel` workflow.
The future chat runner will consume the shared `Model` service.

## Data and execution rules

SQLite owns durable records. An Effect queue can wake a worker, but it does not
replace persisted pending runs or task occurrences. A single owner executes runs
and refreshes credentials. The neutral worker host uses the store lock and a
protected Unix socket for commands while its selected services are active.

Store normalized model messages, tool requests, tool results, versioned provider
continuation data, and each run's provider/model selection. Trimming context must
preserve complete exchanges, their continuation data, and tool request/result
pairs. Limit loaded memory, tool output, model turns, and tool calls. Stop clearly
when the active exchange alone exceeds the context budget.

Keep credentials separate from notes, memory, and tool-readable files. Limit tools
to the configured notes directory, including resolved symlink targets. The runner
enforces allowed tools before invoking them. Scheduled runs begin with read-only
tools.

Do not automatically retry a side effect whose completion is uncertain. Record
its state and require an explicit retry. Note writes use atomic replacement;
database updates use transactions. Exactly-once external execution is not assumed.

## Unattended operation

The CLI's `worker.ts` parses actions, selects the platform, and supplies absolute
Bun and entry-point paths, a working directory, and an explicit settings
allowlist. `@poppet/platform` defines the shared action, error, and launch data.
`@poppet/platform-macos` owns LaunchAgent installation and control, plist
encoding, bounded subprocesses, and log reading. It depends on the platform
contract and Effect, and does not import task scheduling or CLI configuration.
Only the macOS implementation is currently provided.

`KeepAlive` lets launchd restart the combined `worker run` process, with a
30-second throttle. Removing the registration sends SIGTERM; Effect finalizers
interrupt work and release resources. Mutating control operations finish under
an uninterruptible region, and launchctl subprocesses are killed after 35 seconds
if they do not finish. Only exit 113 confirms that a service is absent; other
inspection errors preserve its registration and plist. API keys remain in
protected provider storage and are excluded from the host's launch environment.
See [Apple's launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).

`@poppet/credentials/lock` shares storage ownership between conversation storage,
ChatGPT credentials, and API-key mutations. A small lock database uses
[SQLite exclusive locking](https://www.sqlite.org/pragma.html#pragma_locking_mode),
which remains held across transactions and is released by the OS after a crash.
An atomic PID marker preserves compatibility with older file-lock owners and
permits automatic reclamation only for a known dead process. Unknown markers or
live PIDs remain blocked. Lock databases are protected and are never removed
while an owner might hold them. They contain no user credentials or records.

The task package owns status data and recent occurrence summaries. The host
supplies `WorkerConnections` through its registered provider layers. Status
whitelists safe metadata and caches it before model resolution so it remains
available while ChatGPT credentials are owned by an active run. Cached status
includes its observation time. This reports local credentials and consent, not
live account verification. Running and stopped status derive their provider set
from the configured provider and saved tasks. Task results and note permissions use the existing
store and agent behavior. No second runner or service implementation is added.

Scheduling uses wall-clock UTC times and a one-second wake timer. A timer delayed
by sleep enqueues one due occurrence and records the skipped interval; it does
not replay every missed recurrence. Expiry, quota pauses, and explicit retry rules
remain in the task package. Native startup and physical sleep/wake need manual
validation in addition to injected lifecycle and clock tests.

## Worker host

`apps/cli/src/worker-host.ts` owns one scoped runtime and protected listener.
`worker run` starts scheduling and messaging together, `tasks work` starts only
scheduling, and `gateway work` starts only messaging. Each uses the same store,
agent, memory, provider resolver, and command functions. The store lock prevents
starting another mode against that data directory. No separate processes or
cross-process model coordination are introduced.

`makeTaskWorker` exposes scheduling and task commands without opening a socket.
The host routes task commands to that service while scheduling is active and to
local task operations otherwise. Gateway-only mode can inspect or configure tasks
without reconciling due occurrences or running scheduled inference. Task-only
mode never builds the messaging layer. Status includes the selected services.
Fatal service failures stop the host and its siblings before storage is released.

`@poppet/worker` owns request protection, body limits, deadlines, disconnect and
shutdown handling. The endpoint retains `store/tasks.sock` so existing clients
can still reach the single store owner. The task package retains only task RPC
validation and response formatting. New macOS installations launch `worker run`;
older installations need uninstall/install once to replace their saved `tasks work`
command. Restart alone continues using the saved launch arguments.

## Interactive worker commands

The neutral host's protected socket accepts interactive requests.
`WorkerRequests` lets the CLI supply `/commands` without importing CLI command
schemas or memory behavior into the task package. The host validates chat,
memory, and store-status payloads and uses the same command functions as direct
local execution. New chat payloads include the client's provider, model, and
workload; continued chats resolve their saved session. Notes paths and chat
budgets come from the worker's existing layers.

The listener owns the full request, including JSON body decoding, in a scoped
fiber. Body reads have a 10-second deadline; idle timeouts are disabled only after
a streaming response is ready. The transport accepts up to 2 MiB, leaving room
for a supported 1 MiB serialized chat context and command metadata. Oversized
requests return a clear size error without local fallback.

Each streaming response owns a worker-scoped fiber and a bounded output queue. Responses
stream validated stdout/stderr frames and end with an explicit success or failure
frame. Disconnecting a client interrupts its fiber, finalizes the run, and releases
the shared agent permit. Worker shutdown also cancels queued and active requests
before releasing storage. Session IDs and interactive output go to the client,
not the worker log. Memory edits affect subsequent run snapshots.

Clients check the same socket ownership and permissions as task commands. Only
absence or connection refusal permits direct local execution. Once delivered,
commands are never replayed after a transport error, malformed frame, or missing
completion. Older workers must be restarted to expose the new endpoint. No saved
record schema or migration changes are needed.

## Messaging gateway

Discord thread chat is implemented after interactive worker support. Telegram
and WhatsApp adapters remain planned. The gateway runs
inside the neutral worker host, with scheduling optional, and shares its store, memory, model
resolver, and serialized `Agent` instance with CLI and scheduled requests. The
CLI composes these scoped services and preserves existing worker commands and
local IPC. No second process acquires SQLite, and messaging connections do not
expose the local command socket to the network.

### Package boundaries

The `@poppet/gateway` package owns validated incoming messages,
authorization, conversation-to-session mapping, durable message acceptance, and
reply delivery. `@poppet/channel-discord` owns Discord credentials, Gateway
connections, event decoding, mentions, thread operations, formatting, and rate
limits. Later channel packages implement the same small contract. The CLI owns
adapter registration and live layer composition; neither the agent nor task
scheduling imports concrete messaging adapters.

The shared contract carries the adapter and bot account identity, external
message and conversation IDs, sender ID, text, and reply destination. Keep
platform IDs as opaque strings. Adapters expose scoped incoming events and text
delivery, typing, and message-status operations; add other capabilities only when implemented. Messaging is
independent of inference providers, so a channel can use any configured provider
that supports the session's workload. Call the typed agent interface directly
and consume completed runs rather than parsing CLI stdout or stderr.

`ChannelRegistration` in `@poppet/gateway` defines identity, setup help, setup,
and lazy loading. The CLI registry is `apps/cli/src/channel-registry.ts`; it is the
only CLI module importing a concrete channel package. The generic host generates
help, dispatches setup, and composes each configured channel with its own gateway
instance. Gateways share the store, repository, and agent permit. A fresh gateway
layer per registration keeps message streams, authorization, and sessions isolated.

The host provides only `ChannelEnvironment.dataDirectory` and bounded secret input
through `ChannelInput`. Adapters own argument schemas, credential handling,
setup messages, and platform loading. Configuration inspection returns either no
configured layer or a layer that connects only when built. Discord exposes a
lightweight `@poppet/channel-discord/registration` entry and loads its SDK lazily.
Existing setup commands and settings files are unchanged.

`gateway status` reports connection state and configuration errors in a `channels`
array, with enabled state and persisted queue/delivery totals at the top level.
Totals are read once from the shared repository. Configuration failures remain
isolated to their registration, and stopped status does not build connections.
Tests append fake registrations and exercise setup, help, simultaneous message
handling, separate sessions, shared serialization, status, and resource cleanup.

Channel packages own protected credential storage, separate from model-provider
credentials, notes, and memory. Reuse compatible protection and locking helpers
without treating a Discord bot token as a model-provider connection. Tokens stay
out of logs, command output, launch arguments, and LaunchAgent environment data.
Persist non-secret channel settings so the installed worker can load them.

Discord settings and a redacted token share the protected
`channels/discord.json` file, separate from inference credentials. Setup reads
the token through stdin and writes atomically under the shared ownership-lock
helper. The worker loads this file at startup. discord.js 14.27.0 owns Gateway
heartbeats, reconnect/resume, and Discord API encoding. Ambiguous REST failures
are not automatically retried by the SDK. Adapter failures stay in connection
status, leaving the local CLI and scheduler available.

### Discord threads as sessions

The first adapter supports text conversations in explicitly configured guilds
and parent text channels, restricted to one configured Discord user ID. The flow
is:

1. An actual mention of the bot ID in an allowed channel starts a thread from
   that message. Its text becomes the first input in a new Poppet session.
2. A message from the allowed user inside any allowed thread attaches a session
   if needed, without requiring a mention. It never creates a nested thread or
   imports unrelated history.
3. Subsequent messages in that thread continue the same session. Only messages
   in parent channels require an explicit mention to start a session.
4. Replies remain in the thread. A different thread starts a separate session;
   an existing binding retains its saved provider, model, and workload.

Persist a unique binding from adapter, bot account, guild, and thread IDs to the
Poppet session ID. Keep the initiating message ID for thread-creation recovery.
Renaming or archiving a thread does not reset its session. If Discord no longer
permits access or delivery, preserve the local history and report the failure
locally instead of sending the answer to another channel. A new thread is the
normal way to start a fresh conversation.

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
crashes and network errors may leave stale markers. Progressive edits,
attachments, voice, DMs, and forum-specific behavior are deferred.
See Discord's [thread permissions](https://docs.discord.com/developers/topics/threads#permissions)
and [message content rules](https://docs.discord.com/developers/events/gateway#message-content-intent).

Authorization applies to every incoming message and control command before
creating a session or invoking the model. A status or cancel command is scoped to
the current thread's session and the allowed user. Keep personal memory and notes
available only in channels the owner has explicitly chosen for that context.
Threads inherit parent-channel visibility: sender authorization does not make
replies private. Start in an owner-controlled private channel. Supporting other
users or shared channels requires an explicit memory and tool-access policy;
separate sessions alone do not isolate the current shared profile, facts, or notes.

### Acceptance, execution, and delivery

Add numbered store migrations for conversation bindings, accepted message IDs,
and delivery records. The gateway owns their repository through the shared
`StoreDatabase`; the store retains database ownership and migration history.
Deduplicate by adapter, bot account, and external message ID. Persist accepted
work before advancing a transport cursor or acknowledging receipt where the
platform provides such a mechanism. Bound pending work and reject overload
clearly. Preserve message order within each conversation through the existing
serialized runner.

Link accepted inputs to their session and run durably before execution can
produce side effects. Reconnects must not create duplicate threads, sessions, or
runs. Recover thread creation by inspecting the initiating message's thread;
uncertain external operations require reconciliation, not blind replay. Queued
inputs that have not started may resume after restart. Runs that started and
were interrupted retain the store's existing no-replay rule and require an
explicit new request. Cancellation interrupts only the owned queued or active
request and releases its runner permit.

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

Migration 7 implements bindings, inbox records, and ordered reply chunks. The
gateway reserves a run ID before execution and supplies it to `Agent.send` and
the store. Stable session IDs recover a crash between session creation and
thread binding. Recovery inspects the saved run before deciding whether an
accepted input never started or already completed/interrupted. The worker has
one sequential messaging processor and an independent reply-delivery loop; the
agent's existing permit still serializes all model work across messaging, CLI,
and scheduled requests. Pending inputs are capped at 64 per bot account.

Discord's Gateway has no application-level acknowledgement tied to SQLite.
Incoming events use a bounded in-memory queue before acceptance, with dropped
and rejected counts in local status. Session history and accepted inputs survive
restart; delivery of events lost before acceptance or after an unrecoverable
disconnect is not guaranteed. `gateway status` reports persisted pending, failed,
and uncertain delivery counts even when the worker is stopped. Thread-scoped
`@Poppet /status` and `@Poppet /cancel` are text controls rather than registered
slash commands. Live Discord checks remain manual.

### Later messaging support

After Discord thread chat, allow scheduled results to target an explicitly
configured, authorized conversation. Persist the destination with the occurrence
and deliver its saved completed result independently of inference. Revalidate
destination authorization before sending. Do not infer a recipient from whichever
thread was used most recently.

Add Telegram next with bot-token authentication and long polling, retaining the
same authorization, session-binding, deduplication, and delivery rules. WhatsApp
follows a separate choice between a QR-linked WhatsApp Web adapter and the
official Business Cloud API. The former carries unofficial-client account and
protocol-compatibility risks; the latter needs business setup, a public signed
webhook, and handling for outbound conversation-window/template restrictions.
Verify current platform requirements when implementing each adapter. Neither
later adapter is required to complete Discord support.

## Dependencies

The foundation uses Effect 4.0.4, its Bun platform adapter, TypeScript 7.0.2,
Oxfmt 0.73.0, Oxlint 1.88.0, and Bun 1.4.3 with matching Bun types. Bun checks types;
TypeScript provides editor support. Versions are pinned and the lockfile is
checked in. Effect provides Config and Schema, so a separate schema
library is unnecessary.

Subscription verification adds OpenAI 7.32.0 for Responses streaming and jose
6.2.12 for JWT/JWKS validation. The official sign-in devkit was not available as
an installable package when this flow was added, so OAuth follows the documented
public-client protocol directly. Scheduled tasks use Effect Cron for five-field
expressions with explicit timezones. Tests cover DST, downtime, and durable
occurrence transitions without another scheduling dependency.

References: [Effect installation](https://effect.website/docs/v4/getting-started/installation),
[services](https://effect.website/docs/v4/requirements-management/services),
[configuration](https://effect.website/docs/v4/configuration), and
[process runtime](https://effect.website/docs/v4/platform/runtime).

## Session and conversation naming

`@poppet/store` owns title metadata and atomic attempt claims. Migration 8 leaves
existing sessions unnamed. New sessions begin with a fallback; accepting their
first user input replaces it with a normalized prompt title in the same durable
transaction. Scheduled sessions instead save the task name at creation. Manual
renames and generated results update metadata without changing activity ordering.
Generated results replace only fallback titles, so an in-flight request cannot
overwrite a manual rename. Usage is stored separately from conversation runs.

`@poppet/agent` owns fallback normalization and a tool-free naming request using
the session's pinned selection. It reads only the first original user prompt,
limits the excerpt to 2048 Unicode characters, bounds title output to 1024 UTF-8
bytes, and applies a ten-second deadline. The request has no shared prompt data,
conversation continuation, tools, transcript writes, or automatic retries. A
persisted claim precedes model resolution. The host prints or delivers the saved
answer before asking the agent to name the session. Both paths use the existing
model-access permit and owning process scope.

The gateway's optional channel naming capability returns creation ownership,
reads current names, and conditionally renames managed conversations. Bindings
retain source-message provenance, the last confirmed name, pending update, and
last title considered. The gateway considers only successfully delivered answers
for optional inference. External edits disable synchronization, and uncertain
acknowledgements are reconciled without a second remote mutation. The Discord
adapter owns SDK calls, permissions, platform name limits, and error mapping;
other adapters can omit the capability. Inference-provider packages are unchanged.
