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

The Bun monorepo has five private workspaces:

| Workspace                   | Responsibility                                                              | Workspace dependencies                      |
| --------------------------- | --------------------------------------------------------------------------- | ------------------------------------------- |
| `@poppet/cli`               | Process startup, commands, terminal output, live layer composition          | Config, OpenAI provider                     |
| `@poppet/config`            | Validated settings and the `AppConfig` service                              | Provider contract                           |
| `@poppet/provider`          | Normalized messages, stream events, continuation, provider/model services   | None                                        |
| `@poppet/provider-opencode` | OpenCode Go catalog, secret configuration, and protocol routing             | Provider contract, OpenAI protocol adapters |
| `@poppet/provider-openai`   | OpenAI sign-in, credential lifecycle, model catalog, subscription inference | Config                                      |

The CLI lives in `apps/cli`; libraries live in `packages/config` and
`packages/provider-openai`, `packages/provider`, and `packages/provider-opencode`.
Each workspace owns its dependencies, TypeScript config, and colocated tests. Libraries expose explicit package exports. Imports
between workspaces use those exports. Internal imports use `#src/*` aliases,
defined in each workspace's `package.json` and mapped to `./src/*.ts`.
Provider workflow helpers and test fixtures remain internal. Bun and TypeScript
resolve these package-local aliases without extra `tsconfig` path mappings.

Root scripts preserve `bun run start`, `bun run dev`, and `bun run check`.
Start and dev run the CLI without changing the working directory. Root checks
cover formatting, linting, tooling configuration types, every workspace's types,
and all tests. The workspaces share `tsconfig.base.json` and one lockfile.

The CLI owns `runtime.ts` and composes live layers supplied by the packages.
OAuth, browser sign-in, credentials, and model access stay together in the OpenAI
provider package. A shared provider contract and a separate OpenCode provider
package supply the selected model before durable conversation storage.

## Modules

The implemented modules below live under `packages/provider-openai/src`, except
configuration in `packages/config/src` and CLI files in `apps/cli/src`.
Shared provider types live in `packages/provider/src`, and Go routing lives in
`packages/provider-opencode/src`. Storage,
agent, tools, memory, and scheduler modules are planned.

| Module                | Responsibility                                                              | Dependencies                                      |
| --------------------- | --------------------------------------------------------------------------- | ------------------------------------------------- |
| `config.ts`           | Validate settings and provide `AppConfig`                                   | Effect Config and Schema                          |
| `connection.ts`       | Credential schemas, redacted tokens, typed connection errors                | Effect Schema and Data                            |
| `auth/credentials.ts` | Atomic credential replacement and exclusive owner lock                      | Configuration, scoped filesystem access           |
| `oauth/`              | OAuth service with discovery, HTTP, token, and identity modules             | Fetch, Effect Schema, jose                        |
| `sign-in/`            | Sign-in service with one-use callback and browser modules                   | Scoped Bun listener and subprocess                |
| `auth/`               | Auth service with login, refresh, and pure state modules                    | Configuration, sign-in, OAuth, credential storage |
| `model/`              | Model service with SDK adapter, stream collector, and verification protocol | Authentication, OpenAI client                     |
| `store.ts`            | SQLite migrations, sessions, messages, runs, facts, jobs                    | Configuration, scoped Bun SQLite connection       |
| `agent.ts`            | Bounded conversation context and sequential tool loop                       | Model, store, memory, tools                       |
| `tools.ts`            | Validated tool definitions and execution policies                           | Schema, scoped filesystem access                  |
| `memory.ts`           | Editable profile and explicitly saved facts                                 | Store, configuration                              |
| `scheduler.ts`        | Persisted due occurrences and sequential worker                             | Store, agent, clock, occurrence calculator        |
| `cli.ts`              | Typed commands and terminal presentation                                    | Application services required by each command     |

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
modules are implemented. `runtime.ts` composes the ChatGPT layers for
auth commands and only the selected provider for general provider commands. SQLite storage, the agent loop, tools, memory, and scheduling are
planned.

## Provider interface

The shared interface is implemented before durable conversation storage so
its schema can preserve normalized messages and provider continuation data.
The future agent will depend on one selected `Model` service supplied by the CLI
runtime. `provider models` and `provider verify` exercise this boundary now.

| Workspace                   | Responsibility                                                                  |
| --------------------------- | ------------------------------------------------------------------------------- |
| `@poppet/provider`          | Shared messages, tools, model descriptions, stream events, and inference errors |
| `@poppet/provider-openai`   | ChatGPT authentication, OpenAI request translation, streams, and continuation   |
| `@poppet/provider-opencode` | OpenCode Go credentials, discovery, per-model protocol selection, and streams   |
| `@poppet/cli`               | Provider/model configuration and composition of the selected live layer         |

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

`resolve` validates and binds a provider/model selection. The future agent obtains
`Model` through Effect and calls `model.stream(request)` for each model turn.
Keep discovery and connection commands separate from the agent's inference
dependency. Authentication flows remain provider-specific.

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
An explicit model is required for provider verification and future agent runs.
Help, configuration, and connection commands remain usable before selection.
Credentials stay in separate
protected storage or provider-specific secret environment values and never
appear in printable application settings.

The CLI builds only the selected provider's live dependencies. Resolve the
selection at run start and record it with the run. Keep it fixed through every
tool round trip. Configuration changes affect new runs, and changing providers
initially starts a new session because continuation data may not be portable.
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

The pure protocol adapters in `@poppet/provider-openai/protocol` bind a model
description and a supplied client Effect. Both providers reuse Responses parsing;
Go also uses Chat Completions parsing. These adapters do not open a ChatGPT
credential store. The contract package imports no SDK types.

Responses continuation retains validated output items, including encrypted
reasoning. Chat Completions continuation retains `reasoning_content`; normalized
assistant output retains text and ordered tool calls. Each assistant message owns
its continuation. Adapters reject mismatched provider/model/version/protocol data.

A scoped abort controller and an Effect clock enforce a 60-second absolute
inference deadline. Consumer termination aborts the request before awaiting the
iterator's cleanup, so a pending network read cannot block cancellation. SDK
retries are disabled. Shared adapter tests use injected HTTP responses and a test
clock; phase 1 live evidence and future live Go checks are separate.

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
