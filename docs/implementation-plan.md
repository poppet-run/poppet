# Poppet implementation plan

Status: Foundation and live subscription verification complete; provider interface next

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
| Additional provider clients         | Supported Go protocols; select and pin clients when implementing each adapter          | Provider interface        |
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

Planned only. Complete this phase before durable conversation storage so its
schema follows the shared message and continuation contracts. See the
[planned provider interface](architecture.md#planned-provider-interface) for the
service contract and adapter requirements.

1. Add `@poppet/provider` with Effect Schema definitions for normalized messages,
   tools, model descriptions, requests, completion events, continuation payloads,
   and typed inference errors. Define provider discovery/resolution operations
   and the selected `Model` service. Bind the provider/model during resolution.
2. Adapt `@poppet/provider-openai` to expose general inference through `Model`.
   Exercise the shared request and response contract in subscription verification
   while retaining ChatGPT sign-in and protected credentials. Preserve streamed
   output ordering, missing-terminal-output reconstruction, and reasoning/tool
   continuation. Keep model discovery and connection management separate from
   the agent's inference dependency.
3. Add validated `POPPET_PROVIDER` and `POPPET_MODEL` configuration. Use
   `openai-chatgpt` and `opencode-go`, with `openai-api` reserved for later API-key
   support. Require an explicit model for agent runs. Help, configuration, and
   connection commands remain usable before selection. Keep secrets out of
   printable settings. Compose only the selected provider's live dependencies
   in the CLI runtime, without opening unrelated credential stores.
4. Add `@poppet/provider-opencode` for Go API-key access, discovery, and per-model
   protocol routing. Support an explicit model/protocol set first, then expand
   coverage after validating each protocol. Send a Poppet user agent and stable
   `x-opencode-session`. Resolve Go's documented coding-agent workload requirement
   before enabling it for general notes or scheduled-assistant tasks.
   [OpenCode Go requirements](https://opencode.ai/v2/docs/console/go/)

Adapters emit completed responses only after successful protocol completion.
Text deltas and partial tool arguments cannot authorize tool execution. Validate
model capabilities and generation settings before sending a request. Close
streams on cancellation or early consumer termination, and keep automatic model
retries disabled.

Resolve the configured provider/model at run start and keep it fixed through tool
round trips. Store versioned provider continuation data alongside normalized
messages in phase 3. Only the matching adapter interprets that data. Configuration
changes affect new runs; provider changes initially start a new session. Do not
silently select another provider or model.

Completion check: local adapter tests complete the same text and tool exchange
through the shared contract for both providers. Cover continuation preservation,
output ordering, missing completion, malformed or failed streams, cancellation,
unsupported settings, and configured layer selection. Live provider checks remain
separate evidence. A fake `Model` supports later agent tests without either
account. No agent loop or conversation database is implemented in this phase.

## Phase 3: Durable credentials and storage

Depends on phase 2.

Keep credentials in protected local storage separate from transcripts, notes, and
memory. Refresh near expiry, serialize refresh attempts, and atomically replace
credentials. Reuse the saved host identifier and registration. Add sign-in,
connection-status, and sign-out commands. Sign-out attempts session revocation and
clears local tokens even when revocation fails, while reporting the failure.
[Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)

The credential storage, refresh, auth commands, and exclusive auth-command lock
are already implemented alongside phase 1. Authentication currently stores one
account. A process crash can leave a lock requiring manual removal after checking
that no auth command is running; automatic stale-lock recovery is deferred.

Build a scoped `Store` layer using Bun SQLite. Add migrations for `sessions`,
`messages`, and `runs`. Persist the shared normalized messages, versioned provider
continuation data, each run's provider/model selection, status, timestamps,
results, and failure reasons. Record pending work before execution. Add a
single-owner lock before multiple processes can access credentials or execute work.

Completion check: reconnecting reuses registration, refresh survives restart,
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
