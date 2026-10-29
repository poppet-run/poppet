# Poppet architecture

[Documentation index](README.md)

The CLI runs chat locally when no worker owns the data directory. A running
worker handles CLI requests, scheduled tasks, and messaging through one store
connection and serialized agent. Background installation is available on macOS.

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

The Bun monorepo uses private workspaces:

| Workspace                     | Responsibility                                                                     | Workspace dependencies                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `@poppet/cli`                 | Process startup, commands, terminal output, live layer composition                 | Config, agent, browser, MCP, memory, skills, tasks, store, platform, provider layers |
| `@poppet/browser`             | Isolated browser tools, settings, pinned daemon lifecycle, bounded native requests | I/O helpers, provider contract, Effect                                               |
| `@poppet/mcp`                 | Scoped stdio/HTTP clients, OAuth sign-in, bounded discovery, schema validation     | Credentials, sign-in, provider contract                                              |
| `@poppet/agent`               | Persisted chat, bounded context, deadlines, terminal run states                    | Config, I/O helpers, memory, skills, store, web search, provider contract            |
| `@poppet/io`                  | Bounded stream and subprocess I/O, shared HTTP URL and public-address validation   | None                                                                                 |
| `@poppet/web-search`          | Brave/Kagi search adapters, validation, and bounded source results                 | I/O helpers, Effect                                                                  |
| `@poppet/config`              | Validated settings and the `AppConfig` service                                     | Provider contract, credential locks, browser and MCP configuration schemas           |
| `@poppet/credentials`         | Protected API-key and record storage, locks, and environment overrides             | Provider contract                                                                    |
| `@poppet/store`               | SQLite ownership, migrations, conversation records, and run lifecycle              | Config, credentials, provider contract                                               |
| `@poppet/memory`              | Memory contract, local facts, bounded profile and fact snapshots                   | Config and store for the local implementation                                        |
| `@poppet/platform`            | Worker actions, errors, status, launch description, and bounded log reading        | I/O helpers                                                                          |
| `@poppet/platform-macos`      | macOS LaunchAgent control and plist generation                                     | Platform contract                                                                    |
| `@poppet/platform-linux`      | systemd user unit control and unit file generation                                 | Platform contract, I/O helpers                                                       |
| `@poppet/tasks`               | Scheduling, task persistence, recovery, and task commands                          | Config, agent, store, worker transport, provider contract                            |
| `@poppet/worker`              | Protected local command transport and request lifecycle                            | Effect                                                                               |
| `@poppet/gateway`             | Authorized messaging, thread bindings, durable inbox, and reply delivery           | Agent, config, credentials, store, provider contract                                 |
| `@poppet/channel-discord`     | Discord connections, mentions, threads, permissions, and protected settings        | Gateway contract                                                                     |
| `@poppet/provider`            | Shared contracts and operations, with protocol adapters through a separate export  | None                                                                                 |
| `@poppet/provider-opencode`   | OpenCode Go catalog, secret configuration, and protocol routing                    | Provider contract, credentials, protocol adapters                                    |
| `@poppet/provider-openrouter` | OpenRouter catalog, model capabilities, and secret configuration                   | Provider contract, credentials, protocol adapters                                    |
| `@poppet/provider-openai`     | OpenAI sign-in, credential lifecycle, model catalog, subscription inference        | Credentials, sign-in, provider contract, protocol adapters                           |
| `@poppet/sign-in`             | Browser authorization: loopback callback, pasted callbacks, deadline               | Effect                                                                               |

The CLI lives in `apps/cli`; libraries live in `packages/`.
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

Configuration, connection, credential, OAuth, sign-in, auth, model, and CLI
modules are implemented. `runtime.ts` builds only the registered provider selected
for an auth or inference command. Its store layer opens SQLite for saved-data operations and worker execution.
Help, configuration, skill file inspection, and provider commands do not
open the conversation database.

## Explicit local skills

`Skills` in the agent package loads one validated `SKILL.md` or lists local skill
directories. The CLI composes `SkillsLive` with host configuration. When a host
supplies `Skills` and the 8 KiB skill-index limit is nonzero, the conversation
workflow builds a bounded index at run start and adds the read-only
`poppet_skills.view_skill` tool, a context-only tool journalled like recall. It
grants no additional tool permissions. Creation requests carry only the selected
name; the process owning the store resolves it, including worker chat and task
commands. Missing or invalid selections fail before creating a session or task.

The gateway parses `/new --skill <name> <message>` and `/new <message>` after
sender authorization. They use the durable request queue rather than the immediate
status/cancel path. A valid command creates a fresh session with the worker's
configured provider/model and optional skill snapshot, then atomically updates
its conversation binding and inbox entry. Earlier sessions remain inspectable.
The reserved inbox run ID makes new-session identity stable across a crash before
binding, so recovery reuses a saved snapshot without rereading the file. Selection
errors are delivered without changing the binding or invoking a model. The parsed
prompt supplies inference and fallback titles; `/status` includes the skill name.
Naming updates also check session identity so stale work cannot update a newer
binding. Adapters and provider packages require no skill-specific changes.

The shared store schema defines the bounded name/content snapshot and
nullable snapshots on sessions and jobs. Task execution copies the saved
snapshot into each occurrence session without filesystem access. The agent adds
one saved snapshot to the run's instructions, below base rules, and the existing
context budget accounts for its serialized bytes. The conversation loop owns batch validation, permissions, and budgets;
`tool-execution.ts` owns tool dispatch, outcome classification, and journal writes. Provider packages need
no skill-specific behavior. See [skills](skills.md).

## Provider interface

The shared interface defines normalized messages and provider continuation
data independently of durable conversation storage.
The agent depends on `ModelResolver`, supplied by the CLI runtime, and calls the
resolved model through the shared contract. `provider models` lists normalized model descriptions through the same provider
interface.

| Workspace                     | Responsibility                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `@poppet/provider`            | Shared inference, connection, registration, message contracts, and protocol adapters |
| `@poppet/provider-openai`     | ChatGPT authentication, OpenAI request translation, streams, and continuation        |
| `@poppet/provider-opencode`   | OpenCode Go credentials, discovery, per-model protocol selection, and streams        |
| `@poppet/provider-openrouter` | OpenRouter credentials, catalog capabilities, and Chat Completions binding           |
| `@poppet/cli`                 | Provider/model configuration and composition of the selected live layer              |

OpenRouter reuses the Chat Completions adapter in `@poppet/provider/protocol`.
It discovers concrete text models publicly and loads an environment or saved API key
only when inference begins. Catalog parameters determine each model's supported
settings. Requests require parameter support, disable provider fallbacks, and
send a stable session ID. Continuation preserves structured reasoning deltas in
arrival order, including signatures and opaque provider metadata.

Auth commands accept an explicit provider or default to the provider in `config.json`.
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
- `ModelEvent` supports answer and readable reasoning deltas, and a completed response containing
  authoritative ordered output, tool calls, finish reason, and optional usage.
  Expected failures use the stream's typed error channel. Opt-in reasoning diagnostics
  stay separate from authoritative answer output and encrypted continuation state.
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

The optional `<data directory>/config.json` supplies ordinary settings, including
Discord authorization and the four editable chat controls. `POPPET_DATA_DIR`
selects the data directory and file. Other environment settings are limited to
credentials. Internal context/tool/memory limits use fixed defaults. Provider
selection uses the file's `provider` and `model` fields.
The registered providers are `openai-chatgpt`, `opencode-go`, and `openrouter`.
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
specifies coding-agent traffic; the adapter rejects assistant workloads before
reading credentials or sending inference requests.
[OpenCode Go requirements](https://opencode.ai/v2/docs/console/go/)

The first Go model set is `gpt-6-luna` using Responses and `glm-5.3` using
Chat Completions. Only these models are listed from the remote public catalog;
unrecognized models and Messages protocol models are rejected. The key is read
from `POPPET_OPENCODE_GO_API_KEY` or protected API-key storage only when inference begins. Go requests require
`workload: "coding"`; general assistant tasks fail before credentials are read.

The reusable protocol adapters in `@poppet/provider/protocol` bind a model
description and a supplied client Effect. Both providers reuse Responses parsing;
Go also uses Chat Completions parsing. Provider packages supply request headers,
error classification, and reasoning-continuation extensions. The shared adapters
never branch on provider IDs or open a ChatGPT
credential store. The `@poppet/provider` root export contains shared contracts and
operations without importing SDK types or protocol implementations. The
`@poppet/provider/protocol` export exposes the SDK-dependent adapters from the
same package, which declares the OpenAI SDK dependency.

Responses continuation retains validated output items, including encrypted
reasoning. Go owns `reasoning_content` continuation; OpenRouter owns its structured
reasoning sequence. Normalized
assistant output retains text and ordered tool calls. Each assistant message owns
its continuation. Adapters reject mismatched provider/model/version/protocol data.

A scoped abort controller and an Effect clock enforce a 60-second absolute
inference deadline. Consumer termination aborts the request before awaiting the
iterator's cleanup, so a pending network read cannot block cancellation. SDK
retries are disabled. Shared adapter tests use injected HTTP responses and a test
clock; live provider checks are separate.

## Conversation store

`@poppet/store` exposes a scoped `Store` service through `StoreLive`. The CLI
provides configuration through its store runtime layer; `store status` migrates the
schema and reports counts without opening authentication services.

`database.ts` protects `<data directory>/store`, acquires the process ownership
lock, and opens one Effect SQL client on Bun SQLite with foreign keys, WAL, and full
synchronous commits. Rows come back with camelCase names. Scope finalizers close
SQLite before releasing ownership. Database files and WAL sidecars use owner-only
permissions.

`migrations.ts` provides `migrate`, which runs one package's migrations with
Effect's SQL migrator and its own ledger table, refusing a ledger newer than the
build. The store's baseline holds only conversation tables; memory, tasks, and
gateway define and migrate their own when their layers start. The store layer
also refuses databases it did not create.

`schema.ts` defines session, message, run, and terminal-outcome records with
Effect Schema. `service.ts` validates caller input, checks continuation identity
before saving messages, and decodes rows on read. Table checks enforce valid run
and tool-call states, runs take their provider, model, and workload from their
session when read, and a partial unique index permits only one pending or
running run per session. Services rely on these rules instead of repeating them.

`queueRun` persists its pending run and input messages in one transaction.
`startRun` accepts only pending work. Pending work can fail or be interrupted;
successful completion requires a running run. `recordToolCalls`, `startToolCall`, and
`finishToolCall` journal tool exchanges and their outcomes. `finishRun` atomically saves a successful response and assistant
message, or records a failure/interruption reason. Read methods retain message
order and provider continuation. The `Store` record API exposes no raw SQLite
handle; repositories query the shared `SqlClient` that `StoreLive` also provides.

A new owner marks unfinished runs interrupted with `process-exit`, preserving
their inputs without replaying them. A hard crash releases the OS-held SQLite lock; the next owner replaces any
leftover PID marker through the shared scoped lock helper. Credentials, facts, jobs, context
assembly, and model execution are outside this store's record APIs.

## Persisted chat

`AgentLive` captures `Store`, `ModelResolver`, and validated `ChatSettings`.
Each `send` stream holds two permits for its full lifetime, including persistence
and provider cleanup: one for its session, so two sends to one session never read
the same history or save out of order, and one of `chat.maxConcurrentRequests`
slots shared by interactive, messaging, and scheduled requests. The session permit
is taken first, so a request waiting for a busy session holds no shared slot.
Session permits are removed once no request holds or waits for them. Waiting
consumers can be cancelled before creating a run. Each run reads memory once when
it starts, so a fact saved by a concurrent run appears in the next run.
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

Tool-capable models receive conversation search, explicit
memory, page reading, and web search when configured. The conversation workflow
validates complete tool requests, records them, executes sequentially, and
continues with the saved results. Models without tool support receive no tools.
Text deltas stream immediately; terminal-only text or an unstreamed final suffix
is emitted before committing the answer. The source must end cleanly after one
validated completion matching the session identity. Malformed, missing, duplicate,
or trailing events fail. Text is capped at 128 KiB and serialized completion at
1 MiB. A five-minute absolute deadline includes provider resolution and streaming;
provider adapters retain their own 60-second inference deadlines.

Run finalizers record provider/agent/store failure categories or interruption.
Only completed inference becomes a saved assistant message, atomically with its
result. Stopping consumption or cancelling a request saves no partial answer.
Failed inputs remain visible in `chat show` but are not retried implicitly.
Inspection omits provider continuation while retaining normalized output, usage,
and run failure reasons. Tool results, profile content, and saved facts each have
separate content budgets.

## Tool execution

`conversation.ts` captures the store, memory and pages services, and chat budgets. It keeps
one model instance throughout each run. `reply.ts` forwards text but emits a
completion only after clean source termination and validates continuation,
finish reason, output limits, and agreement with streamed text. Complete tool
requests pass through the shared contract; no SDK types enter the agent.

The loop advertises only allowed tools, validates the whole batch, and requires
another model turn before performing side effects. Default budgets are sixteen
model turns, sixteen calls, and 16 KiB per tool result. Current-run messages are
never trimmed independently of their tool pairs. Definitions and tool results
count toward the context estimate; overflowing the current exchange fails clearly.
Recorded usage sums all model turns when complete usage data is available.

`tool_calls` stores durable tool execution. Store methods atomically record an
assistant tool request with pending calls and a completed tool result with its transcript
message. The state progresses from pending to running to completed or failed.
Run failure/reopening interrupts pending calls and marks remaining running calls
uncertain. Completed calls are immutable; terminal calls cannot restart. Calls
and model requests are never replayed. `chat show` exposes the ledger for manual
inspection. An uncertain mutation requires inspecting the affected state before an explicit retry.

Reported tool failures, including refused arguments and failed page reads, return to
the model within the existing budgets. An invalid batch executes none of its
calls. Uncertain effects end the run without replay. Once page, search, or MCP
content enters a run, or the owner's message carries attachments, task management,
memory changes, and MCP tools are withdrawn until a new owner message. A server configured with
`availableAfterUntrusted` keeps its allowed MCP tools.
See [chat limits](chat.md#context-and-run-limits).

### Reviewed host commands

`agent/bash.ts` defines the native Bash tool and an isolated reviewer request to
the run's resolved model. Review has no tools or continuation and receives only
the owner request, command, working directory, and timeout. It must return a
validated allow/needs-approval/deny decision within thirty seconds. Review failure
stops execution. Each invocation is independently reviewed; approvals are not cached.

The CLI supplies the process runner in `apps/cli/src/bash.ts`. It launches
`/bin/bash` as the host account without profile/startup scripts, bounds output,
and kills the process group on exit, timeout, or cancellation. The tool journal
records invocation and outcome; fatal review failures also save their reason in
the transcript and end the run. Command output is untrusted, but Bash stays
available for subsequent independently reviewed commands.

The gateway holds pending approval IDs in memory for at most two minutes. Owner
controls resolve them outside the inference queue and only in the originating
conversation, with access rechecked before execution. Restart expires pending
requests. Scheduled runs never wait for approval; a blocked command fails the
occurrence. Failed occurrences log a reason code and retain details in task history
without posting to their destination or changing their recurring schedule.
Only completed results enter the durable delivery queue. Pending failure notices
from older versions are stopped before delivery. Delivery is unique per
occurrence and run, so a successful retry can deliver its result to the task's
saved destination.

## Supplied page reading

`agent/pages.ts` defines `poppet_web.fetch_page` and the injected `Pages` service.
The CLI composes it with `PageTransportLive` and chat settings for local, worker,
and scheduled runs. Providers see only the generic tool definition and result.
No store migration or new configuration is needed.

The host extracts canonical HTTP(S) URLs solely from the current user message or
saved scheduled prompt. Completed web searches can add their returned source URLs
for this run only. Whole-batch validation checks the requested initial URL against
that set before any tool executes. History, skills, snippets, and page links
cannot expand it. Page text remains untrusted source material, and guidance asks
the model to cite the returned final source URL.

Every initial/redirect URL rejects userinfo and nonstandard ports, strips its
fragment, resolves A and AAAA records, and rejects the entire answer if any address
is non-public. The IP policy conservatively excludes special-purpose ranges,
including mapped IPv4, translation and transition IPv6, and documentation ranges.
The policy follows the [IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/)
and [IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/) registries.
The HTTP(S) client connects to the selected literal IP, so no second hostname lookup
can rebind the connection. The original hostname supplies Host, SNI, and certificate
identity checks. Fresh connections ignore ambient proxies and send no cookies,
authorization headers, or provider credentials. Redirects are followed explicitly
and checked afresh, with at most three per read.

One Effect deadline covers DNS, connections, redirects, body reads, and extraction
within 15 seconds. Interruption cancels DNS queries and closes active HTTP I/O.
The transport bounds actual transferred bytes to 1 MiB before gzip, deflate, or
Brotli decoding, which independently caps decoded output at 1 MiB. Incomplete bodies,
unsupported compression, HTTP failures, invalid UTF-8, and unsupported MIME types
or charset declarations produce a failed durable tool result. The model can
explain the failure or make another permitted request within the run budgets;
the transport never retries automatically.

Bun's native HTMLRewriter removes non-content elements and adds text boundaries.
A second parse collects the cleaned document because removal still emits text
callbacks. The pinned `entities` decoder handles character references, which the
native parser leaves escaped. UTF-8 plain text retains literal character escapes.
Results include source URL, nullable title, text, and an explicit truncation flag,
all within the existing serialized tool-result budget. There is no browser,
JavaScript execution, PDF support, crawling, page cache, or general integration
framework.

Offline checks inject DNS/transport and static fixtures. Loopback integration
checks use the production HTTP(S) client to prove literal-address connections,
source Host/SNI and TLS identity, proxy isolation, wire/decompression limits, and
cancellation. Fake-model and scheduler checks cover authorization, durable results,
failure without replay, and unchanged restrictions on built-in writes and MCP tools.

## Web search

`@poppet/web-search` owns the `WebSearch` service contract, Brave and Kagi v1 HTTP clients,
response schemas, URL filtering, and Unicode-safe result budgeting. It depends on
`@poppet/io` and Effect, with no dependency on the agent or credential storage.
`agent/web-search.ts` defines `poppet_web.search_web` and validates model arguments.
The conversation maps `WebSearchError` into `AgentError` while preserving its
reason and message. A null search operation means disabled or missing credentials,
so the tool is not advertised.

`cli/web-search.ts` loads credentials and provides the service, and owns the web
setup commands for the selected provider. Configuration layers provide the opt-in flag
and provider selection with
environment-over-file precedence; keys stay outside normal configuration and
inference-provider packages. CLI setup and the local/worker runtime share these
layers. Search and page fetching share URL validation and public-address policy
from `@poppet/io`. No database migration is needed.

Requests use the selected provider's fixed HTTPS endpoint, query-only context, and a separate
authentication header with redirect rejection. An Effect deadline bounds the
request and body to 15 seconds. Streaming reads enforce a 1 MiB response limit;
invalid UTF-8, malformed JSON/schema, unsupported content types, and HTTP failures
produce sanitized agent errors without replay or backend fallback. Cancellation
aborts fetch. Authentication and rate-limit failures have tool-specific reason
codes and never enter inference-provider pause handling.

Results keep at most five source titles, canonical URLs, and snippets in backend
order, within the serialized tool budget. Invalid URLs, private literal addresses,
and URLs that cannot fit are omitted and mark the result truncated. Hostname
address validation remains mandatory when a page is fetched. Only returned
sources gain a run-local page grant after the tool result is durably completed.
Grants come from the fresh service result rather than replayed transcript text.
Whole-batch validation runs first, so search cannot authorize a new fetch in that
same batch. Results omitted by count or byte limits, snippet links, and previous
runs never grant access. Scheduled runs use the same path and retain read-only
memory. Tests cover the request boundary, setup, failure/cancellation,
limits, grant lifetime, and scheduled execution. Live search-to-page inference
and scheduled messaging delivery remain separate manual checks.

## Chat task management

`agent/task-tools.ts` defines `poppet_tasks.manage_tasks`, strict model arguments,
and the narrow `ChatTasks` capability. The host supplies `ChatTasksLive` from `tasks/chat-tools.ts` to
the agent using the existing repository, store, skills, clock, and result budget.
The agent does not import `@poppet/tasks`, which already depends on agent skills.
Provider packages and channel transports remain unchanged.

Only interactive runs advertise the tool. All model calls, including task
preparation, pass whole-batch validation before any tool executes. Preparation
checks action-specific fields, existing IDs, schedules, future one-off times,
selected skill files, and delivery authorization. The current run supplies provider,
model, and workload. Gateway code rechecks the accepted owner and resolves the
current conversation, home channel, or an explicitly selected channel or thread ID
through the same destination and access checks. Model arguments cannot select
another gateway or supply account identities or permission flags. The host
clock supplies a current UTC timestamp to help resolve relative dates. Current
explicit user intent remains an instruction requirement, without a keyword or
model-based permission classifier.

The task service recovers state when built under the new store owner, before
agent or scheduler work starts. Its repository command lock is also used by
worker commands and occurrence claiming. Chat executes directly in that process
and never reacquires the agent permit or calls its own worker socket. The existing
timer reconciles new work. Pause and resume retain repository semantics.

Task controls act on the task's current definition and, for skip/snooze/run-now,
its current next execution: the pending occurrence if one exists, otherwise the
unqueued `next_at` slot. Neither chat nor the CLI inspects the task first.
`task-controls.ts` checks paused/running state, holds, expiry, and future times
inside the same transaction as the mutation. `task-records.ts` shares
record access with the scheduler on the owned connection. A lost worker response
never falls back to local mutation.

Each occurrence saves its definition and revision. Claiming/retrying uses that
snapshot; a pending edit cancels and replaces the original without rewriting
history. Snooze changes persisted `available_at`, not the cron schedule or
logical slot, and run-now queues through normal permissions/provider holds.
See [task controls](tasks.md#edit-and-control-the-next-execution).

`Store.commitToolCall` runs the synchronous task operation and completion of its
tool journal/message in one SQLite transaction. A tool result failure rolls back
the mutation. Completed calls, keyed by run and call ID, return their saved result
without executing again; this is the only replay protection for task changes.
Committed changes survive later inference failure, and uncertain storage outcomes remain inspectable
without automatic replay. List uses bounded ID-cursor queries; show limits recent
occurrences and shortens prompts within the serialized tool budget. No model
answers or unbounded occurrence history are returned by inspection.

Automated checks cover tool-call recovery, atomic rollback, local/worker parity,
destination revocation, scheduled rejection of every action, result limits, and
an interactive pause while a scheduled occurrence waits for the agent. Live
chat creation, pause/resume, and delivered occurrence checks remain separate.

## Conversation search

The schema includes an FTS5 index of completed user messages and final assistant text.
A shared SQL view defines eligibility for the run-completion trigger,
which indexes new exchanges inside the completion transaction. Tool content,
intermediate responses, failed/interrupted inputs, and continuation are excluded.
Messages remain the source of truth; current titles join from sessions at query
time. `Store.searchSessions` validates plain-text queries, quotes FTS terms, binds
parameters, and sizes ranked excerpts from the byte budget. Search and recall
derive a result count and per-item byte cap from the budget instead of fitting
serialized output exactly, so results can run slightly over it.

`agent/search.ts` defines the read-only `poppet_history.search_sessions` and
`poppet_history.read_session` schemas. The conversation loop dispatches them alongside other tools, using the same
namespace/permission checks, durable tool lifecycle, and run budgets. Historical
text is untrusted data, not permission to act. Scheduled runs may search and read without
gaining mutation permissions. The CLI uses the shared worker command schema and
owning store connection, with local fallback only when the worker is unavailable.
Search inspection needs neither provider credentials nor model inference. The
existing single-owner policy governs recall across CLI, task, and messaging
sessions; multiple users would need an explicit access policy.

`store/recall.ts` reads bounded windows around or after eligible message IDs. It
uses the existing search index for eligibility and the shared projection over
original messages for text, returning no raw message or provider records. SQL
caps row counts and text length; serialization caps the whole result to
the 16 KiB tool-output limit with per-message truncation flags. Around-message reads keep
the match when the budget reduces the context window. The forward cursor passes
every returned message even if shortened, so large messages cannot trap paging.

The model searches before reading when it lacks a session ID and cites recalled
statements by session/message IDs. Recall never changes source history, titles,
activity, continuation, memory, permissions, or run-local web-search grants.
`chat show` and its local/worker inspection path remain unchanged; model recall
requires no additional socket command or migration.

## Explicit memory

`@poppet/memory` owns the `Memory` service, fact and snapshot schemas, and
`MemoryError`. Its operations are `snapshot`, `list`, `remember`, `replace`, and
`forget`. `LocalMemoryLive` implements these operations by appending to
`memory_revisions`, reading current facts from the `memories` view, and using editable `<data directory>/profile.md` and `soul.md` files.
It retains up to 128 facts of at most 4096 UTF-8 bytes each.

The store owns database acquisition; the memory package owns its schema. `StoreLive`
also exposes the shared Effect `SqlClient`, allowing the CLI to supply one connection and
owner lock to conversation storage and local memory. The memory implementation
owns fact SQL; the conversation `Store` has no memory operations or dependency on
the memory package.

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
next run reads fresh memory even when continuing an existing session. Tool-capable chat can use `poppet_memory.memory`
for explicitly requested remember, replace, and forget operations. Forgetting affects future memory
snapshots; it does not erase prior messages.

`agent/memory-tools.ts` validates the namespaced model arguments using the shared
key/value schemas and dispatches through `Memory`. A fixed object schema requires
`action`, `key`, and nullable `value`; the decoder checks their action-specific
relationship and rejects extra properties, including forged provenance. The host
supplies the active run ID for remember/replace, preflights the next fact snapshot,
and returns a compact acknowledgement within the tool-result budget. Instructions
require an explicit current-user request; semantic intent is interpreted by the
model rather than a keyword scanner or an extra confirmation interface.

The existing tool journal records memory calls before dispatch. A mutation and
its durable result finish together under graceful cancellation. Storage uncertainty
or failure to persist a committed result never causes automatic replay. A completed
fact change survives a later run failure. `origin: "scheduled"` removes memory writes from scheduled requests; fabricated calls fail the normal permission
check before execution. This extends the existing policy without changing storage
schemas, provider code, or the worker protocol.

Prompt formatting and overall context limits stay in the agent. The CLI selects
the local memory layer directly; an alternate implementation can supply `Memory`
without changing the agent or command handlers. No memory-provider registry is needed.

## Current authentication flow

`CredentialStoreLive` owns the shared storage lock while any of its builds in the
process is open. Builds share one lock and one permit per data directory, so
simultaneous model requests serialize credential reads and refreshes, and another
process stays out until the last build closes.
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
The chat runner uses `ModelResolver` to resolve the saved provider/model for each run.

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

Keep credentials separate from memory and tool-readable files. The runner
enforces allowed tools before invoking them. Scheduled runs retain read-only MCP tools and exclude memory/task writes.
The host Bash tool follows the same command review as interactive runs, but
fails the occurrence when human approval is needed.

Do not automatically retry a side effect whose completion is uncertain. Record
its state and require an explicit retry. Database updates use transactions. Exactly-once external execution is not assumed.

## Unattended operation

The CLI's `worker.ts` parses actions, selects the platform, and supplies absolute
Bun and entry-point paths, a working directory, and an explicit settings
allowlist. `@poppet/platform` defines the shared action, error, status, and
launch data, plus protected log creation and bounded log reading.
`@poppet/platform-macos` owns LaunchAgent installation and control, plist
encoding, and bounded launchctl subprocesses. `@poppet/platform-linux` owns the
same lifecycle for a systemd user unit through `systemctl --user`. Neither
imports task scheduling or CLI configuration. Other platforms report no service.

The installed CLI entry point is `worker-background.ts`. This process boundary
holds a separate log ownership lock and launches `main.ts worker run` with piped
stdout/stderr. `worker-log.ts` serializes writes and rotates at 5 MiB with three
archives, closing each file before renaming it. Foreground workers still write
to the terminal. The launcher forwards SIGINT/SIGTERM, drains both streams, and
preserves the child exit code. It stops the child on logging failure and allows
25 seconds for graceful shutdown before killing it. Existing installations need
uninstall/install to select this entry point. Log inspection shares one 64 KiB
budget across current and archived files without following links.

`KeepAlive` lets launchd restart the launcher and combined `worker run` process, with a
30-second throttle. Removing the registration sends SIGTERM; Effect finalizers
interrupt work and release resources. Mutating control operations finish under
an uninterruptible region, and launchctl subprocesses are killed after 35 seconds
if they do not finish. Only exit 113 confirms that a service is absent; other
inspection errors preserve its registration and plist. API keys remain in
protected provider storage and are excluded from the host's launch environment.
See [Apple's launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).

On Linux the unit uses `Restart=always` with `RestartSec=30`, `TimeoutStopSec=30`,
and `UMask=0077`. `KillMode=mixed` sends SIGTERM only to the launcher, which
forwards it like launchd's single signal; the rest of the group receives only
the final SIGKILL. Unit values are quoted and escaped for specifiers and
variable expansion, and control characters are rejected. `systemctl show`
reports an absent unit as `LoadState=not-found`; any failed inspection preserves
the unit file. A unit file that is present but not loaded is reloaded before it
is started or disabled. See [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
and [systemd.unit](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html).

`@poppet/credentials/lock` shares storage ownership between conversation storage,
ChatGPT credentials, and API-key mutations. A small lock database uses
[SQLite exclusive locking](https://www.sqlite.org/pragma.html#pragma_locking_mode),
which remains held across transactions and is released by the OS after a crash.
An atomic PID marker records the owner for diagnostics. Once the SQLite lock is
acquired, a leftover regular marker is replaced without checking PID liveness,
including when its PID has been reused. Invalid marker files fail closed. Lock
databases are protected and are never removed while an owner might hold them.
They contain no user credentials or records.

The task package owns status data and recent occurrence summaries. The host
supplies `WorkerConnections` through its registered provider layers. Status
whitelists safe metadata and caches it before model resolution so it remains
available while ChatGPT credentials are owned by an active run. Cached status
includes its observation time. This reports local credentials and consent, not
live account verification. Running and stopped status derive their provider set
from the configured provider and saved tasks. Task results and tool permissions use the existing
store and agent behavior. No second runner or service implementation is added.

Scheduling uses wall-clock UTC times and a one-second wake timer. A timer delayed
by sleep enqueues one due occurrence and records the skipped interval; it does
not replay every missed recurrence. Expiry, quota pauses, and explicit retry rules
remain in the task package. Native startup and physical sleep/wake need manual
validation in addition to injected lifecycle and clock tests.

## Worker host

`apps/cli/src/worker-host.ts` owns one scoped runtime and protected listener.
`worker run` starts scheduling and messaging together, and `worker run --tasks-only` starts only
scheduling. Both use the same store,
agent, memory, provider resolver, and command functions. The store lock prevents
starting another mode against that data directory. No separate processes or
cross-process model coordination are introduced.

`makeTaskWorker` exposes scheduling and task commands without opening a socket.
The host routes task commands to that service. Task-only mode never builds the
messaging layer. Status includes the selected services and messaging status.
Fatal service failures stop the host and its siblings before storage is released.

`@poppet/worker` owns request protection, body limits, deadlines, disconnect and
shutdown handling. The host exposes `/v1/tasks` and `/v1/commands` through
`store/tasks.sock`. Both routes reject unknown request fields; unsupported routes
return 404. The task package owns task RPC validation and response formatting.
macOS installations launch `worker run`.

## Interactive worker commands

The neutral host's protected socket accepts interactive requests.
`WorkerRequests` lets the CLI supply `/v1/commands` without importing CLI command
schemas or memory behavior into the task package. The host validates chat,
memory, and store-status payloads and uses the same command functions as direct
local execution. New chat payloads include the client's provider, model, and
workload; continued chats resolve their saved session. Chat
budgets come from the worker's existing layers.

The listener owns the full request, including JSON body decoding, in a scoped
fiber. Body reads have a 10-second deadline. The Unix-socket listener disables
Bun idle timeouts so quiet requests can wait for the shared runner; per-request
timeout changes are ineffective on this transport. The transport accepts up to 32 MiB, leaving room
for four 5 MiB attachments as base64, the chat context, and command metadata. Oversized
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
completion. Restart the worker after updating code so the client and host use
the same protocol. Saved record migrations are independent of the wire protocol.

## Messaging gateway

`conversation-naming.ts` owns rename reconciliation and owner-override handling.

Discord thread chat is bundled. Additional adapters can be loaded from explicitly
configured installed packages.
The gateway runs
inside the neutral worker host, with scheduling optional, and shares its store, memory, model
resolver, and serialized `Agent` instance with CLI and scheduled requests. The
CLI composes these scoped services and preserves existing worker commands and
local IPC. No second process acquires SQLite, and messaging connections do not
expose the local command socket to the network.

Scheduled task delivery uses the same durable reply queue. The host supplies
`TaskDestinations` to resolve explicit conversation selections through enabled
gateways. Each task and occurrence saves a `DeliveryDestination` containing the
adapter, account, owner, scope, parent, and conversation identity. The gateway
reconciles completed occurrences into completed inbox entries without creating
bindings or model requests. A unique occurrence/run index makes this idempotent;
queue insertion and chunk creation commit together. The normal delivery loop
rechecks current policy and adapter permissions and preserves bounded retries
and uncertain-send handling. Delivery status never changes execution status.

### Package boundaries

The `@poppet/gateway` package owns validated incoming messages,
authorization, conversation-to-session mapping, durable message acceptance, and
reply delivery. `@poppet/channel-discord` owns Discord credentials, Gateway
connections, event decoding, mentions, thread operations, formatting, and rate
limits. External adapters implement the same small contract. The CLI owns
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

`worker status` reports messaging connection state and configuration errors in a `channels`
array, with enabled state and persisted queue/delivery totals at the top level.
Totals are read once from the shared repository. Configuration failures remain
isolated to their registration, and stopped status does not build connections.
Tests append fake registrations and exercise setup, help, simultaneous message
handling, separate sessions, shared serialization, status, and resource cleanup.

Channel packages own protected credential storage, separate from model-provider
credentials and memory. Reuse compatible protection and locking helpers
without treating a Discord bot token as a model-provider connection. Tokens stay
out of logs, command output, launch arguments, and LaunchAgent environment data.
Persist non-secret channel settings so the installed worker can load them.

Discord authorization lives in `config.json`; the protected `channels/discord.json`
contains only the token. Discord supplies the bot identity after authentication.
Setup reads the token through stdin and
merges ordinary settings atomically under ownership locks. Loading settings does
not rewrite either file.
The worker reads both files at startup. discord.js 14.27.0 owns Gateway
heartbeats, reconnect/resume, and Discord API encoding. Ambiguous REST failures
are not automatically retried by the SDK. Adapter failures stay in connection
status, leaving the local CLI and scheduler available.

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
   an existing binding retains its saved provider, model, and workload.

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
crashes and network errors may leave stale markers. Progressive edits,
attachments, voice, DMs, and forum-specific behavior are deferred.
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
slash commands. Live Discord checks remain manual.

### External adapters

The CLI loads default `ChannelRegistration` exports listed in `gatewayPackages`
from `<POPPET_DATA_DIR>/gateways`. Discord remains bundled. See
[adding a channel](development.md#adding-a-channel) for setup and compatibility.

## Dependencies

The foundation uses Effect 4.0.4, its Bun platform adapter, TypeScript 7.0.2,
Oxfmt 0.73.0, Oxlint 1.88.0, and Bun 1.4.4 with Bun 1.4.3 types. Bun checks types;
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

`@poppet/store` owns title metadata and atomic attempt claims.
New sessions begin with a fallback; accepting their
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

The gateway's channel naming capability returns creation ownership,
reads current names, and conditionally renames managed conversations. Bindings
retain source-message provenance, the last confirmed name, pending update, and
last title considered. The gateway considers only successfully delivered answers
for optional inference. External edits disable synchronization, and uncertain
acknowledgements are reconciled without a second remote mutation. The Discord
adapter owns SDK calls, permissions, platform name limits, and error mapping;
other adapters can omit the capability. Inference-provider packages are unchanged.

## MCP clients

`@poppet/mcp` owns configuration schemas, prompt policy, inspection commands,
errors, allowed tool contracts, and the official SDK's local stdio and
Streamable HTTP connections and discovery. Both transports share one connection
lifecycle; HTTP adds a byte-bounded `fetch` and ends its session on close. It depends on credentials and the provider contract, with no agent
or application-config dependency. The lightweight `@poppet/mcp/config` export lets
`@poppet/config` validate the file section and resolve its paths without importing
the SDK or starting a client.

The CLI supplies the tool-result byte limit to `makeMCPLive` and adapts its tools
and errors to the agent through `ExternalAgentToolsLive`. `ExternalTools` in
`@poppet/agent` stays generic, including optional host-owned instructions. MCP
policy comes from its package; server instructions never enter that hook. The
existing loop includes tool definitions in context budgeting, validates whole call
batches, records original identities, and dispatches calls with the normal tool
budgets and run cancellation.

Durable calls have nullable `server_id` and `tool_name` columns.
Built-in calls retain null identities. Running calls settle as uncertain when
interrupted or recovered; neither the agent nor MCP client replays them. Reported
tool errors are failed; post-dispatch transport or protocol errors are uncertain.

Discovery freezes permissions until owner restart. The strict one-string wrapper
retains original JSON Schema validation and optional-field semantics across
providers. Selected credentials stay out of prompts and inspection. Worker
inspection exposes only servers, status and allowed catalog discovery; invocation
continues through the normal durable agent path. See [MCP tools](mcp.md) for limits,
credential references, supported schemas, and the live validation path.

## Browser automation

The host composes optional browser tools alongside MCP tools through
`ExternalAgentToolsLive`. The generic `ExternalTools.snapshot` receives host-owned
session/run IDs and runs in the conversation stream's resource scope. Browser
setup is deferred until the first browser action and reused within that run. Its
resources close with the run, including failure and cancellation,
while general MCP connections retain worker ownership.

`@poppet/browser` owns strict tool arguments, configured host restrictions, snapshots,
current references, result budgeting, and per-run state. `browser-process.ts`
owns capped version probes, the pinned native daemon, and bounded requests over
its private Unix socket. It never invokes a shell or creates another model loop.
Native MCP schemas and handshake passed a compatibility probe, but unrestricted
launch/session arguments and detached child ownership require this fixed adapter.

`allowedDomains: ["*"]` explicitly allows all HTTP(S) hosts. This skips the host
allowlist and omits domain filters from both daemon environment and launch
arguments. URL credentials, other schemes, and arbitrary browser actions remain
rejected; isolation, budgets, and lifecycle ownership still apply. Since the
native domain filter also blocks WebRTC, wildcard launches retain that protection
through a fixed private startup script and Chrome's non-proxied UDP restriction.

The package exports its settings schema through `@poppet/browser/config`;
`@poppet/config` reads it alongside other file settings.
The CLI adapts browser tools and `BrowserError` to the generic agent contract.
Browser calls use the existing external-tool identity and durable
uncertain outcomes. Scheduled catalogs omit every browser operation. See
[browser automation](browser.md) for setup, bounds, permissions, and live checks.
