# Poppet implementation plan

Status: Durable conversation storage implemented and locally tested; persisted chat next

Updated: 2026-10-13

One user, one active ChatGPT account, a configured provider/model, a local
TypeScript application, SQLite, explicit memory, and locally scheduled tasks.
Start with a CLI calling the runner directly. Introduce a background service
when scheduling requires it.

Subscription access remains the first functional milestone. Verify the documented
route against the user's account before building the agent around it.
[OpenAI integration guide](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)

## Dependency order

| Dependency                          | Purpose                                                                                | Introduce                 |
| ----------------------------------- | -------------------------------------------------------------------------------------- | ------------------------- |
| Bun, TypeScript, Bun types          | Runtime, strict type checking, SQLite, tests                                           | Foundation                |
| Effect and its Bun platform adapter | Configuration, schemas, services, cancellation, resource scopes, retries               | Foundation                |
| Oxfmt and Oxlint                    | Formatting and lint checks                                                             | Foundation                |
| OpenAI client                       | Streamed Responses API access                                                          | Subscription verification |
| jose                                | JWT/JWKS identity validation for the documented OAuth flow                             | Subscription verification |
| Additional provider clients         | Supported OpenCode Go protocols; select and pin clients when implementing each adapter | Provider interface        |
| Occurrence calculator               | Timezone-aware recurring occurrences; assess Effect Cron before adding another package | Scheduled tasks           |

Pin dependencies as they are introduced. See [architecture.md](architecture.md)
for Effect service boundaries and execution rules.

## Phase 1: Foundation and subscription verification

The foundation includes project scripts, strict TypeScript, an Effect-based CLI,
configuration validation, behavior tests, and continuous integration. Bun
workspaces separate `@poppet/cli`, `@poppet/config`, and `@poppet/provider-openai`,
while preserving the root development commands. The auth flow is implemented
with Effect services and layers in the provider's `src/connection.ts` and
`src/auth/`, `src/oauth/`, `src/sign-in/`, and `src/model/` directories. Each capability has a
service module and focused workflow helpers; `auth/credentials.ts` owns protected
storage. See [architecture.md](architecture.md) for the module boundaries.

Implemented behavior generates and persists a host identifier, starts a scoped
loopback callback listener, and opens the system browser. Authorization uses
code flow with PKCE, state, and nonce. Credentials are validated and protected,
refresh is serialized, and sign-out attempts revocation before clearing tokens.

The user signs in, selects a workspace, and authorizes ChatGPT plan usage. Exchange
the authorization code, validate the returned identity and granted permissions,
and save the issued client ID for subsequent sign-ins. Follow the supported
registration and token-exchange flow without reading another application's tokens.
[Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)

`auth models` discovers visible account models. `auth verify [model]` completes
two streamed Responses requests and a local namespaced function-tool round trip,
then records the verified model and time. The implementation classifies reconnect,
usage-limit, transient service, unsupported request, interrupted stream, and
context-limit failures. It does not automatically retry model requests.

Local-provider tests cover registration reuse, PKCE, JWT signature/audience/nonce
and expiry, denied consent, refresh rotation, storage permissions, competing
owners, revocation failure, callback cleanup, and incomplete model streams. They
do not establish live account access.

Live subscription verification passed on 2026-10-13 with `gpt-6.1-sol`, completing
inference and a local tool round trip using Poppet's signed-in account. The
subscription stream supplied output through `response.output_item.done` while
the final `response.completed` output array was empty; inference now retains
completed items in output order. A regression test covers this response shape.
Live token renewal remains a follow-up in phase 3. Verification requests use
subscription quota.

Completion check: the account completes inference and a tool round trip through
the documented subscription route. Denied permission or unsupported access leaves
a clear connection state. Foundation work alone does not complete this phase.

## Phase 2: Provider interface and configured model

Depends on phase 1.

Implemented with an initial supported Go model set and an OpenRouter adapter. See the
[provider interface](architecture.md#provider-interface) for the service contract
and adapter requirements.

- `@poppet/provider` defines Effect Schemas for normalized messages, tools, model
  descriptions, requests, completion events, and versioned continuation. `Provider`
  discovers and resolves models; `Model` binds one provider/model for inference.
- Provider packages export registrations with their own live composition and
  connection operations. The CLI registers them once and uses shared interfaces
  for auth, model discovery, and inference. Provider IDs are generic; configuration
  validates them against the registry. Shared protocol codecs live in
  `@poppet/provider-protocol`, with provider-owned headers, reasoning extensions,
  and error classification. A synthetic registered provider exercises the same
  command and storage paths without modifying shared code.
- `@poppet/provider-openai` exposes general Responses inference through that
  contract, retaining ChatGPT sign-in and protected credentials. Subscription
  verification now uses the shared tool-exchange workflow. Streamed completed
  items retain their output order when terminal output is omitted. Encrypted
  reasoning is requested and retained for subsequent turns.
- `POPPET_PROVIDER` defaults to `openai-chatgpt`; `opencode-go` and `openrouter` are also supported.
  `openai-api` remains reserved and is rejected. `POPPET_MODEL` has no default.
  `provider verify` requires it before opening credentials. Help, configuration,
  and auth commands work before selection. Only the selected provider's live
  dependencies are built, and a resolved model cannot silently change selection.
- `@poppet/provider-opencode` discovers the public Go catalog and uses a separately
  validated, redacted API key from login storage or `POPPET_OPENCODE_GO_API_KEY`
  for inference. The initial set is
  `gpt-6-luna` on Responses and `glm-5.3` on Chat Completions. Requests send a Poppet
  user agent and stable `x-opencode-session`. Other model/protocol combinations
  remain deferred until tested.
  [OpenCode Go endpoints and requirements](https://opencode.ai/v2/docs/console/go/)
- `@poppet/provider-openrouter` discovers concrete text models from the public
  catalog and derives their supported settings. Inference uses a redacted
  API key from login storage or `POPPET_OPENROUTER_API_KEY` through Chat
  Completions for both workload types.
  Requests require parameter support, disable provider fallbacks, and preserve
  session identity and the full reasoning sequence across tool exchanges.
  Dynamic routers and models that produce images or audio are excluded.
- Auth commands accept an explicit provider or default to `POPPET_PROVIDER`.
  ChatGPT retains browser sign-in. `@poppet/credentials` supplies protected,
  atomic API-key storage for OpenCode Go and OpenRouter. Login uses a hidden
  prompt, environment input, or `--key-stdin`; status and logout keep providers
  separate. Inference reads saved keys when no environment override is present.

Go documents coding-agent workloads. General notes and scheduled-assistant work
is not established as supported, so the Go adapter rejects `assistant` requests
before key access or inference. Verification uses an explicit `coding` workload.

Adapters emit authoritative completion only after a successful protocol terminal
response and validated output. Partial text and tool arguments never authorize
tool execution. Model capabilities and generation settings are checked before
requests. Failed, incomplete, malformed, or truncated streams fail distinctly.
Request scopes close on cancellation or early consumer termination. An Effect
clock enforces an absolute inference deadline. Automatic model retries remain
disabled.

Continuation is attached to each normalized assistant message. Responses retains
validated response items and encrypted reasoning; Chat Completions retains
reasoning content alongside normalized text and ordered tool calls. Adapters
validate continuation version, protocol, provider, and model before sending it.
Phase 3 will store these messages, continuation, and run selection durably.

Local completion checks cover the same text and tool exchange through ChatGPT
Responses, Go Responses, Go Chat Completions, and OpenRouter Chat Completions, including output ordering,
missing terminal output, malformed arguments, incomplete streams, cancellation,
deadlines, safe error classification, unsupported settings, and selected layer
composition. Fake `Model` tests require no account. The public Go and OpenRouter
catalogs were checked on 2026-10-13; live Go and OpenRouter inference and a fresh
live ChatGPT check through the new contract remain separate checks. No agent loop or conversation database is
implemented in this phase.

## Phase 3: Durable credentials and storage

Depends on phase 2.

Keep credentials in protected local storage separate from transcripts, notes, and
memory. Refresh near expiry, serialize refresh attempts, and atomically replace
credentials. Reuse the saved host identifier and registration until explicit logout.
Sign-out deletes all local connection details before attempting session revocation,
reports revocation failures, and leaves other providers' credentials intact.
Status reads do not recreate deleted details; the next login starts a fresh registration.
[Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)

The credential storage, refresh, auth commands, and exclusive auth-command lock
are already implemented alongside phase 1. Authentication currently stores one
account. A process crash can leave a lock requiring manual removal after checking
that no auth command is running; automatic stale-lock recovery is deferred.

Implemented `@poppet/store` with a scoped Bun SQLite connection under
`<data directory>/store/poppet.sqlite`. Its process ownership lock is acquired
before opening or migrating the database and released after the connection
closes. Database files and WAL sidecars have owner-only permissions. Store
commands do not build authentication or model layers.

Numbered migrations create `sessions`, `messages`, `runs`, and indexes. An
application ID, schema version, and checksummed ledger reject unrelated
databases, newer versions, and changed history. All pending migrations and their
ledger entries commit together or roll back together.

Sessions and runs retain provider/model selection. Messages persist the shared
normalized history, tool calls/results, and versioned continuation. Input batches
and pending runs are saved atomically before execution. The service validates
transitions and allows one pending or running run. Successful completion saves
its assistant message and result atomically; failures and interruptions retain
separate reasons. Reopening marks abandoned work interrupted without replay.

`bun run start store status` opens/migrates the database and prints schema and
record counts without a login or selected model. Tests cover reopening and
upgrades, migration and record-write rollback, complete tool exchanges across all
providers, continuation identity, invalid records, competing owners, and
interruption cleanup. Facts and jobs remain for their later phases. The chat
runner remains phase 4 work.

Live ChatGPT token renewal remains a follow-up; the storage implementation does
not establish that live check. Automatic recovery of crash-left ownership locks
remains deferred.

Completion check: reconnecting before logout reuses registration, login after logout
creates a fresh host identity and registration, refresh survives restart,
unusable credentials request reconnect, and stored records migrate and reopen
correctly. Test interrupted credential writes and competing owners.

## Phase 4: Persisted chat

Depends on phase 3.

Add `agent.ts` and CLI chat commands. Submit messages directly to the runner,
persist them, assemble bounded context, call the selected `Model` service, and
save the result. The agent imports the shared provider contract without importing
concrete providers or SDK types. Record the resolved provider/model with each
run and keep it fixed through tool round trips. Keep one active run. Retain
complete exchanges, their continuation data, and tool request/result pairs when
trimming history. Bound profile, facts, and tool content separately.

For subscription inference, stream with `store: false`, send required history in
each request, and use the documented instruction format. Mark success only after
completed inference. Apply deadlines and cancellation through Effect. Interrupted
streams remain distinguishable from completed answers.
[Subscription request requirements](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

Completion check: chat across several turns, restart, and continue the session.
Invalid authentication, plan limits, excessive context, interrupted requests, and
temporary failures leave inspectable run states.

## Phase 5: Tools and notes

Depends on phase 4.

Collect tool requests from completed model responses, decode arguments with
Effect Schema, enforce the run's allowed tools, execute them, append results, and
call the model again.
Add `read_note`, `search_notes`, then `save_note`. Enforce the notes-directory
boundary for relative paths, absolute paths, and symlink targets. Cap returned
content and enforce model-turn and tool-call budgets.

Declare tools through the shared provider contract; each adapter translates the
provider's supported format. Persist tool-call identifiers, arguments, execution
state, and results. Note writes use atomic replacement. A crash after a write but
before its result is recorded is an uncertain outcome, never an automatic repeat
of the write.

Completion check: find notes, read them, and save a summary. Invalid arguments,
forbidden paths or tools, write failures, cancellation, and exhausted budgets
terminate predictably. Verify crash recovery without repeating a write.

## Phase 6: Explicit memory

Depends on phase 5.

Add `memory.ts`, a `memories` table, and typed CLI commands for listing,
remembering, replacing, and forgetting facts. Load an editable `profile.md` and
bounded saved facts at the start of each run. Facts have stable keys, values,
source runs when applicable, and update times.

Save facts only when explicitly requested. Start with CLI management. Add a
model-callable memory tool later if chat usage establishes a need for it.

Completion check: save a preference, use it in a fresh session, update it, and
forget it across restarts. This completes the first personal-assistant milestone.

## Phase 7: Durable scheduled tasks

Depends on phases 5 and 6.

Add `scheduler.ts`, a `jobs` table, and typed task-management CLI commands. Support
one-off timestamps and recurring expressions with explicit timezones. Persist the
next occurrence in UTC. Add a single background owner and protected local client
communication when this phase needs simultaneous CLI access.

Transactionally enqueue due work and advance the schedule. Use a unique
task-and-occurrence key. An Effect queue only wakes the worker; SQLite retains
pending work. Each occurrence gets a fresh session with current memory and
read-only note tools. Save final answers as task results.

Define these policies before writing the worker:

- Skip recurring occurrences missed while the process was stopped. Record the
  skipped interval. Run overdue one-off tasks once.
- Keep at most one pending occurrence per recurring job. Skip further occurrences
  while one is pending or running, and record what was skipped.
- Pausing a job cancels pending occurrences. An active run must be cancelled
  explicitly. Retain job configuration and previous results.
- During a usage-limit pause, keep at most one pending occurrence per recurring
  job. Apply an explicit expiry for stale summaries before resuming. Keep overdue
  one-off work pending until it runs or the user cancels it.
- After a crash, mark active runs interrupted for manual retry. Reconcile pending
  work before considering new occurrences. Never automatically repeat uncertain
  side effects.

Use the shared provider failure classification. Stop new model requests for the
affected provider when a quota limit is reported; temporary failures get bounded
backoff only where repeating the operation is safe. Credentials and job
configuration survive failures.
[Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)

Completion check: schedule a notes summary, inspect its result, pause it, and
restart around a due time without duplicate runs. Test daylight-saving changes,
long-running jobs, downtime, plan-limit recovery, and explicit one-off failures.

## Phase 8: Unattended operation

Depends on phase 7.

Add background startup, graceful shutdown, readable status commands, and access
to previous results. Use scoped layers and finalizers for connections, listeners,
and worker fibers. Verify sleep and wake behavior and single-owner enforcement.

Expose the active account, whether plan usage is enabled, and the action needed
for reconnecting or resuming requests. Treat notes and model output as untrusted
content; enforce tool permissions in the runtime.

Completion check: a daily summary runs unattended while the machine is awake,
survives restarts, and leaves inspectable results, skipped occurrences, or failures.

## Validation

Use behavior tests with injected `Model`/auth layers and a controllable clock.
Run shared text and tool-exchange cases against each provider adapter, including
stream completion, cancellation, and continuation preservation.
Exercise persistence against temporary SQLite databases. Keep live account checks
focused on subscription access, token renewal, one tool round trip, and the
completed assistant flow. Do not claim these live checks passed from fake-provider
tests.
