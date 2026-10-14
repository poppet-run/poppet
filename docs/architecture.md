# Poppet architecture

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

The Bun monorepo has ten private workspaces:

| Workspace                     | Responsibility                                                              | Workspace dependencies                            |
| ----------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------- |
| `@poppet/cli`                 | Process startup, commands, terminal output, live layer composition          | Config, agent, store, provider layers             |
| `@poppet/agent`               | Persisted chat, bounded context, deadlines, terminal run states             | Config, store, provider contract                  |
| `@poppet/config`              | Validated settings and the `AppConfig` service                              | Provider contract                                 |
| `@poppet/credentials`         | Protected API-key storage, locks, and environment overrides                 | Provider contract                                 |
| `@poppet/store`               | SQLite ownership, migrations, conversation records, and run lifecycle       | Config, provider contract                         |
| `@poppet/provider`            | Normalized messages, streams, connection services, registration contracts   | None                                              |
| `@poppet/provider-protocol`   | Reusable Responses and Chat Completions codecs and scoped streaming         | Provider contract                                 |
| `@poppet/provider-opencode`   | OpenCode Go catalog, secret configuration, and protocol routing             | Provider contract, credentials, protocol adapters |
| `@poppet/provider-openrouter` | OpenRouter catalog, model capabilities, and secret configuration            | Provider contract, credentials, protocol adapters |
| `@poppet/provider-openai`     | OpenAI sign-in, credential lifecycle, model catalog, subscription inference | Provider contract, protocol adapters              |

The CLI lives in `apps/cli`; libraries live in `packages/config` and
`packages/provider-openai`, `packages/provider`, `packages/provider-opencode`,
`packages/provider-openrouter`, `packages/provider-protocol`, `packages/credentials`, `packages/store`, and `packages/agent`.
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
Memory and scheduler modules are planned.

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
| `agent/notes.ts`        | Note schemas, bounded filesystem access, atomic replacement                 | Config, chat settings, scoped filesystem access   |
| `memory.ts`             | Editable profile and explicitly saved facts                                 | Store, configuration                              |
| `scheduler.ts`          | Persisted due occurrences and sequential worker                             | Store, agent, clock, occurrence calculator        |
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
and chat commands. Chat and notes tools are implemented; memory and scheduling remain planned.

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
automatic stale-lock recovery remains deferred. Credentials, facts, jobs, context
assembly, and model execution are outside this store's record APIs.

## Persisted chat

`AgentLive` captures `Store`, `ModelResolver`, and validated `ChatSettings`.
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

Tool-capable models receive the three notes tools. The conversation workflow
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
and run failure reasons. Tool results have a separate content budget. Profile
and fact budgets arrive with memory support.

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

## Current authentication flow

`CredentialStoreLive` owns the filesystem lock for an auth command's scope.
`BrowserSignIn` owns an ephemeral listener at `127.0.0.1` and releases it on
success, failure, timeout, or interruption. Shutdown drains the current response
so the browser receives the callback page. The callback consumes one attempt
and validates state before handling errors or using the code.

`OAuthClient` discovers endpoints from the fixed OpenAI issuer, validates their
origin, exchanges codes, and verifies RS256 identity tokens against JWKS. The
issued client ID is retained before exchange so a failed code can be replaced
without registering again. Verified identity must match the saved account before
credentials are replaced. An Effect semaphore serializes refresh and credential
mutations within the command; the filesystem lock excludes other commands.

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
and refreshes credentials; a background process will require a lock and protected
local communication before it shares data with a CLI client.

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

## Dependencies

The foundation uses Effect 4.0.4, its Bun platform adapter, TypeScript 7.0.2,
Oxfmt 0.73.0, Oxlint 1.88.0, and Bun 1.3.14 with matching Bun types. Versions are
pinned and the lockfile is checked in. Effect provides Config and Schema, so a separate schema
library is unnecessary.

Subscription verification adds OpenAI 7.32.0 for Responses streaming and jose
6.2.12 for JWT/JWKS validation. The official sign-in devkit was not available as
an installable package when this flow was added, so OAuth follows the documented
public-client protocol directly. Add an occurrence calculator only when persisted schedules need it.
Assess Effect's cron support then; timezone and downtime behavior must pass the
same tests whichever calculator is chosen.

References: [Effect installation](https://effect.website/docs/v4/getting-started/installation),
[services](https://effect.website/docs/v4/requirements-management/services),
[configuration](https://effect.website/docs/v4/configuration), and
[process runtime](https://effect.website/docs/v4/platform/runtime).
