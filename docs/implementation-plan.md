# Poppet implementation plan

[Documentation index](index.md)

Status: Phases 1–16 implemented with automated checks; macOS login startup, physical sleep/wake, live unattended inference, live title inference, live conversation recall, live skill-assisted chat and scheduling, live URL-assisted chat and scheduling, live Discord behavior, live scheduled-result delivery, live Telegram behavior, and live WhatsApp behavior require manual validation

Phase 12's Telegram and WhatsApp adapters are implemented with automated checks. Discord thread chat, scheduled-result delivery, conversation
search, local Markdown skills, supplied-URL reading, and phase 16 naming are
implemented.

Updated: 2026-10-16

One user, one active ChatGPT account, a configured provider/model, a local
TypeScript application, SQLite, explicit memory, and locally scheduled tasks.
Start with a CLI calling the runner directly. Introduce a background service
when scheduling requires it.

Extend that worker with messaging support after phase 9. Start with Discord
mentions and one saved session per thread, then add scheduled-result delivery
and other messaging adapters.

Subscription access remains the first functional milestone. Verify the documented
route against the user's account before building the agent around it.
[OpenAI integration guide](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)

## Dependency order

| Dependency                          | Purpose                                                                                                                | Introduce                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Bun, TypeScript, Bun types          | Runtime, strict type checking, SQLite, tests                                                                           | Foundation                |
| Effect and its Bun platform adapter | Configuration, schemas, services, cancellation, resource scopes, retries                                               | Foundation                |
| Oxfmt and Oxlint                    | Formatting and lint checks                                                                                             | Foundation                |
| OpenAI client                       | Streamed Responses API access                                                                                          | Subscription verification |
| jose                                | JWT/JWKS identity validation for the documented OAuth flow                                                             | Subscription verification |
| Additional provider clients         | Supported OpenCode Go protocols; select and pin clients when implementing each adapter                                 | Provider interface        |
| Occurrence calculator               | Timezone-aware recurring occurrences; assess Effect Cron before adding another package                                 | Scheduled tasks           |
| Discord client                      | Gateway lifecycle, thread operations, and rate limits; select a Bun-compatible client and pin it during implementation | Discord gateway           |
| Other messaging clients             | Assess each platform's HTTP API or client when its adapter is implemented                                              | Later messaging adapters  |

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
account. Phase 8 adds shared crash-safe ownership and automatic recovery for known
dead processes. Unknown legacy locks still require manual inspection after
confirming that no old auth command is running.

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

Implemented `@poppet/agent` and `chat new [--coding] <message>`,
`chat send <session> <message>`, `chat sessions`, and `chat show <session>`.
One-shot commands send one message. `chat interactive [session] [--coding] [--skill <name>]`
adds a terminal prompt for a new or resumed session. Blank lines do not create work,
and `/exit`, Ctrl-D, or Ctrl-C leave the prompt. Active cancellation retains the
existing interrupted-run behavior. Turns share the local/worker command path;
structured worker session metadata preserves the identity even when the first
turn fails. Unacknowledged outcomes stop without replay. Automated checks cover
local/worker parity, selection and skill snapshots, failure recovery, cancellation,
and redirected-input rejection. An isolated pseudo-terminal check verifies line
editing and exit keys with a fake provider. Live provider use remains manual. Sessions
pin provider, model, and workload. Migration 3 persists workload with an
`assistant` default for existing sessions/runs. The host resolves providers
inside the request scope so credential ownership survives through streaming.

The runner saves input before provider resolution, enforces one active run,
streams text, and commits an answer only after exactly one completed response
and clean stream termination. Provider errors, invalid completion sequences,
oversized context/output, cancellation, early consumption, and a 90-second
absolute deadline leave inspectable terminal runs. Partial answers are not
committed; failed inputs remain inspectable but are excluded from later context.
No automatic retries or provider/model fallbacks are enabled.

Context preserves complete exchanges and opaque continuation. Limits cover
recent exchanges, serialized UTF-8 bytes, requested output tokens when supported,
and model capacity when advertised. This is an estimate rather than an exact
tokenizer. Trimming does not delete stored history. Phase 5 adds the tool loop
and separate tool-content budgets. Profile/fact budgets arrive with phase 6.

Tests cover restart/resume with continuation, changed environment settings,
provider resource lifetime, provider failures, context trimming, malformed
streams, deadlines, cancellation, CLI inspection, and schema upgrades. Live chat
against an account remains a manual completion check; local tests do not claim
fresh subscription or API-key access.

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

Implemented the sequential tool loop in `@poppet/agent`, with `poppet_notes.read_note`,
`poppet_notes.search_notes`, and `poppet_notes.save_note`. Tools are supplied only to models
advertising tool support. Every batch is decoded and permission-checked before
execution. Whole tool exchanges and provider continuation remain together across
model turns and history trimming. Model-turn, tool-call, result-size, context,
and aggregate text limits bound the run. The absolute run deadline remains 90
seconds, and model requests are never retried or switched to a fallback.

Migration 4 adds durable call IDs, ordering, names, raw arguments, execution
states, output, and failure reasons. Complete tool requests are recorded before
execution; successful results commit with transcript messages. Graceful
cancellation keeps an in-flight atomic save and result persistence together.
Reopening interrupts queued calls and marks unfinished started calls uncertain.
No call is replayed. `chat show` exposes these states without opaque continuation.

The notes service restricts UTF-8 `.md`, `.markdown`, and `.txt` files to the
configured directory. It rejects escaped paths, symlinks, and hard-linked files.
Reads, search traversal and matches, result content, and writes have explicit
bounds. Note writes use protected temporary files, sync, and atomic replacement.
Tests cover find/read/save/resume, filesystem boundaries, malformed and forbidden
calls, duplicate IDs, budgets, cancellation, migration recovery, and a successful
write whose result could not be persisted. Live provider use remains a manual
check. Profile and saved facts remain phase 6 work.

## Phase 6: Explicit memory

Depends on phase 5.

Add `memory.ts`, a `memories` table, and typed CLI commands for listing,
remembering, replacing, and forgetting facts. Load an editable `profile.md` and
bounded saved facts at the start of each run. Facts have stable keys, values,
source runs when applicable, and update times.

Save facts only when explicitly requested. CLI management and the model-callable
`poppet_memory.memory` tool are implemented.

Completion check: save a preference, use it in a fresh session, update it, and
forget it across restarts. This completes the first personal-assistant milestone.

Implemented `memory list`, `memory remember`, `memory replace`, and `memory forget`.
Migration 5 adds keyed values, optional source-run provenance, and update times.
Creation and replacement are separate operations; missing keys and duplicate
creation fail clearly. Values are limited to 4096 UTF-8 bytes, with at most 128 facts.

Each run reads `<POPPET_DATA_DIR>/profile.md` and the current facts before resolving
its provider. Missing profiles are empty; existing profiles must be regular UTF-8
files without symlinks. Profile and serialized-fact budgets default to 8192 bytes
each, configurable through `POPPET_PROFILE_BYTES` and `POPPET_FACTS_BYTES`. Oversized
memory fails without truncation. The snapshot stays fixed throughout the run and
counts toward the overall context budget. Resuming reloads current memory.

Tests cover CLI restarts, new and resumed chat context, replacement and deletion,
source runs, migration from schemas 1–4, limits, malformed profiles, and fixed
snapshots during tool execution. Chat does not automatically extract facts. The
model-callable tool handles explicit remember/replace/forget requests through the
same memory service, validates key/value arguments, preflights the next fact
budget, and records the active source run for saved/replaced facts. Current facts
are already in the prompt, so no model listing action is needed. Context files,
history, retrieved content, and skills cannot grant permission to change memory.
Scheduled runs use `readOnlyTools` and cannot write notes or memory.

Memory calls use the existing durable tool journal. Started mutations finish their
result on graceful cancellation; uncertain writes and committed changes whose
results were not persisted are never automatically replayed. Completed changes
remain even if the run later fails. Automated checks cover local/worker parity,
provenance, restart, schema and byte limits, whole-batch validation, scheduled-run
restrictions, cancellation, and failed writes/results. No dependency or store
migration was added. Live model intent handling and memory changes remain manual
checks in the [memory guide](memory.md#ask-the-model-to-change-a-fact).

Memory now lives in `@poppet/memory` behind a small `Memory` service. The CLI wires
`LocalMemoryLive` to the store's shared scoped database. Fact operations and profile
reading belong to that implementation; the agent retains prompt formatting and
overall context limits. Migration 5 and saved data formats remain unchanged.
Tests also cover using an injected memory implementation without local profile access.

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

Implemented with `tasks add/list/show/pause/resume/cancel/retry`, provider pause
inspection and resume commands, and the foreground `tasks work` owner. Migration 6
adds jobs, unique occurrences, skipped intervals, and provider pauses. Effect Cron
calculates five-field schedules with explicit timezones; no dependency was added.
SQLite transactions enqueue work and advance next times together. A bounded Effect
queue wakes one runner. Scheduled sessions load current memory and reject note writes.

Recurring pending work expires after 24 hours; one-offs never expire. Quota pauses
need explicit provider resume. Temporary/rate-limit failures delay subsequent work
from 30 seconds up to five minutes without replaying failed requests. Restart
retains pending work, interrupts active work for manual retry, and recovers answers
committed before an occurrence outcome. Task commands use a protected Unix socket
while the worker owns SQLite. Phase 9 also routes chat, memory, and store status
through that owner.
Automated tests cover scheduling, recovery, injected model runs, and concurrent
task clients. Live provider inference remains a manual check.

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

Implemented with macOS `worker install/start/stop/status/logs/uninstall` commands
and the neutral `worker run` host. Shared launch data lives in
`@poppet/platform`; LaunchAgent control lives in `@poppet/platform-macos`.
The CLI supplies paths and ordinary settings and selects the platform.
The LaunchAgent saves absolute runtime
paths and ordinary settings, starts at login, and keeps the process running with
30-second restart throttling. API keys are excluded from its environment;
providers use protected saved credentials. SIGTERM uses existing scoped cleanup. Lifecycle mutations finish before
interruption returns, with bounded launchctl subprocesses. Inspection failures
retain the installed configuration. Running and stopped status include providers
assigned to saved tasks.

`tasks status` and `worker status` expose scheduling counts, active work, recent
outcomes, provider pauses, and safe local connection metadata with recovery
actions. Full results remain available through `tasks show`. Logs are protected
and bounded on read. A background launcher captures stdout/stderr and rotates
at 5 MiB, retaining three archives. It forwards shutdown and drains output before
exiting; existing LaunchAgents need reinstalling to select it. Automated checks
cover retention, restart, log-path validation, combined log reads, and child
shutdown. Native launchd validation remains manual. Shared SQLite ownership locks recover
dead processes automatically without replaying unfinished requests. Unknown
legacy PID markers still need manual inspection. Saved record schemas and
migration 6 remain unchanged.

Automated checks cover injected launchctl lifecycle operations, protected files,
secret exclusion, process-crash ownership recovery, SIGTERM shutdown, cached
connection status, and scheduling after a simulated sleep/wake clock jump. Native
launchd startup, actual sleep/wake, and a live daily summary remain manual checks.

## Phase 9: Interactive use with the worker running

Depends on phase 8.

Route chat, memory, session inspection, and store status through the existing
protected worker socket. Retain direct execution when the worker is stopped.
Share one model runner between interactive and scheduled requests, and preserve
streamed output, cancellation, saved provider/model selection, and tool permissions.

Implemented with a host-supplied `WorkerRequests` service. `@poppet/worker` owns
the listener and socket protection; the CLI owns interactive command validation,
execution, terminal output, and service composition. The neutral host retains one
listener and the existing socket path; no store migration is needed for the split. The agent holds a single scoped permit across each
request stream, including persistence and provider cleanup. Queued requests can
be cancelled before they start.

The listener owns decoding and command execution. Body reads have a 10-second
deadline, and shutdown interrupts incomplete uploads. A 2 MiB transport limit
covers the supported 1 MiB serialized chat budget plus command metadata;
oversized requests report a size error without being retried.

Responses carry stdout, stderr, and an explicit success or failure frame over a
bounded stream. Client disconnects and worker shutdown interrupt owned requests.
Only an absent socket or refused connection allows local execution; malformed,
lost, incomplete, or older-worker replies never replay a delivered command.
Interactive content is returned to the client without entering worker logs.
Remote execution uses the worker's notes directory and budgets, while new chats
retain the client's selected provider, model, and workload. Auth commands retain
their existing direct credential-storage behavior.

Completion check: leave the worker running, chat, change memory, inspect sessions
and scheduled results, and cancel a request without stopping the worker.
Automated socket tests cover these flows with injected providers, queued chat and
scheduled execution, native transport cancellation, shutdown cleanup, invalid
requests, and safe local fallback after stop. Live provider inference remains a
manual check.

## Phase 10: Messaging gateway with Discord thread sessions

Implemented with automated checks. Depends on phase 9. See the
[messaging gateway architecture](architecture.md#messaging-gateway).

`@poppet/gateway` owns authorization, persisted conversation bindings, incoming
message deduplication, and reply delivery. `@poppet/channel-discord` owns
Discord transport and credentials through pinned discord.js 14.27.0. The CLI registers and composes them inside
a neutral worker host, sharing its store and agent instance. Keep Discord details
out of task scheduling, the agent, and inference-provider packages.

Implement these conversation rules first:

- A mention of the actual bot ID in an explicitly allowed guild/text channel
  creates a thread from that message and starts a Poppet session with its text.
- A message from the allowed user in any allowed thread attaches or resumes its
  session without requiring a mention. Do not create nested threads or import
  its earlier unrelated messages.
- Follow-up text from the allowed user continues an attached thread's session
  without another mention. Each thread has one durable binding, and new threads
  start separate sessions. Existing sessions retain provider/model/workload.
- Replies stay in the thread. Renames, archives, and worker restarts preserve
  the binding; inaccessible or deleted threads never cause delivery elsewhere.

Restrict the first version to one configured user ID and explicit guild/parent
channel allowlists. Check authorization for every message and command before
creating records or invoking the model; ignore bots and webhooks. Use the
Discord Gateway with Message Content intent and validate thread permissions.
Support thread-scoped status and cancellation for the allowed user. Use private
owner-controlled channels initially because replies can contain personal memory
and notes. Broader users or shared channels require a separate context-access
policy before enabling them.

Keep bot tokens in protected channel storage and out of launchd environment
data, logs, and model inputs. Persist non-secret settings for worker startup.
Send only completed text answers, split to platform limits with automatic
mentions disabled. Refresh the typing indicator during model and tool work,
stopping on completion, failure, or cancellation. Indicator failures do not
interrupt requests. The original message gets 👀 during processing and ✅ after
a successful run; failure or cancellation removes the bot's 👀. Reaction errors
do not interrupt requests, and reactions are not durably reconciled after a crash.
Defer DMs, attachments, voice, progressive editing, and
forum-specific handling.

Add migrations and a gateway repository on the shared database for bindings,
accepted external message IDs, run links, and delivery records. Persist accepted
inputs before transport acknowledgement where supported, bound pending work,
and preserve conversation order. Make message-to-run ownership durable before
side effects. Reconcile uncertain thread creation using the initiating message.
Restart may resume inputs that never started; interrupted started runs retain
the existing no-replay policy. Delivery failures retry or reconcile the saved
answer, never inference or tools. Record uncertain sends explicitly because a
lost acknowledgement cannot prove that Discord did not post the reply.

Scope gateway resources to worker shutdown and keep adapter reconnect failures
from stopping CLI or scheduled work. Extend local status with connection state,
queue counts, and failed or uncertain deliveries without exposing message text.

Completion check: mention the bot, receive a threaded answer, continue without a
mention, restart the worker, and continue the same session. A second thread must
have independent history. Verify attachment to an existing thread, renamed and
archived threads, missing permissions, and no fallback to another destination.

Automated tests use injected Discord events/API responses, fake model providers,
temporary SQLite, and a controllable clock. Cover unauthorized messages causing
no sessions or runs, duplicate events creating one thread/session/run, message
ordering, concurrent CLI/scheduled work, cancellation, reconnect, restart before
and after execution starts, rate limits, failed and uncertain chunk delivery,
secret exclusion, and shutdown. Run `bun run check`. Separately validate bot
setup, intent/permission errors, real mentions, thread visibility, follow-ups,
and reconnection in a private Discord test channel. Fake transport tests do not
establish live Discord or model access.

Migration 7 adds gateway bindings, inbox records with reserved run IDs, and reply
chunks. The store and agent accept caller-supplied IDs so a restart can correlate
an accepted message with its run before any tool work, including a crash before
the gateway observed completion. One owner and one guild can be configured with
up to 32 parent text channels. Settings are loaded on worker startup through
`gateway discord setup ... --key-stdin`; `gateway status` reports connection and
persisted execution/delivery counts through the protected worker socket, with
local inspection when stopped. Controls use `@Poppet /status` and
`@Poppet /cancel` text messages within attached threads.

The inbox accepts up to 64 pending/executing inputs per bot account. Transport
events also use a bounded queue; overflow counts appear in status. Discord
Gateway events have no application-level durable acknowledgement, so messages
not yet accepted when the process crashes or an unrecoverable disconnect occurs
can require resending. Accepted inputs and completed answers survive restarts.
Known safe failures use bounded backoff and Discord's rate-limit delay; lost
send acknowledgements remain uncertain for manual inspection. Live Discord
setup, visibility, intent/permission failures, and reconnect behavior remain
unverified. See the [setup and manual path](discord.md).

Channel setup and loading now use `ChannelRegistration` from `@poppet/gateway`,
following provider registrations. Each package owns setup validation, credential
storage, help metadata, and a lazy channel layer. The CLI supplies its data directory
and bounded secret input, generates help, and dispatches through
`apps/cli/src/channel-registry.ts`. Adding a channel requires its package and one
registry entry. Discord's setup command and protected settings file remain
compatible, and its SDK loads only when a connection layer is built.

The host builds separate gateways for configured registrations while sharing the
agent, store, and repository. Status reports per-channel connection/errors in
`channels` and persisted totals once at the top level. Fake-channel integration
coverage exercises setup, help, lazy loading, independent sessions for identical
external IDs, serialized inference, configuration-error isolation, and cleanup.
Stopped status only inspects settings; live messaging remains a manual check.

The neutral worker host supports `worker run` for both services, `tasks work` for
scheduling only, and `gateway work` for messaging only. Scheduling exposes commands
and a run loop without owning the socket. Task commands remain usable when only
the gateway runs, while due occurrences remain untouched until scheduling starts.
Task-only mode does not build messaging settings or the Discord adapter. One
store lock and agent permit cover every mode. Automated tests cover service
selection, shared CLI access, socket cleanup, and ownership across modes. New
LaunchAgents run `worker run`; existing `tasks work` installations need one
uninstall/install to update their saved arguments. Native startup remains manual.

## Phase 11: Scheduled results in messaging conversations

Implemented with automated checks. Depends on phase 10.

`tasks add --discord-thread <id>` resolves an existing thread through a running
messaging worker and checks access before saving. Jobs and occurrences retain
an explicit adapter, bot account, owner, server, parent channel, and thread
snapshot. Existing tasks have no destination. Migration 11 adds these snapshots
and an occurrence identity on gateway delivery records.

The gateway reconciles completed occurrences into its existing ordered reply
queue exactly once, including after restart. Each send rechecks current policy
and thread permissions. Transient delivery failures use bounded backoff; uncertain
sends are retained without automatic resending. Task inspection lists per-chunk
delivery state separately from execution state. Scheduled results do not attach
to or rename the destination's chat session.

Automated checks cover destination selection through both worker command paths,
schema upgrades, snapshots, recovery, changed authorization, revoked/deleted
threads, rate limits, uncertain sends, and local-only tasks. Live scheduled
delivery still needs validation in the private test channel.

Allow a scheduled task to select an explicit authorized Discord thread as its
delivery destination. Snapshot the destination with each occurrence, recheck
authorization before delivery, and route the saved completed result through the
gateway's delivery records. Do not select the last active conversation implicitly
or rerun a task because its reply failed. Preserve scheduling and read-only tool
rules. Keep delivery status separate from occurrence execution status.

Completion check: a scheduled task posts its completed result to the configured
thread. Restart or delivery retry preserves that destination and does not repeat
inference. Tests cover changed configuration, revoked access, deleted threads,
rate limits, uncertain delivery, and tasks without a messaging destination.
Validate one live scheduled delivery separately in the private test channel.

## Phase 12: Additional messaging adapters

Telegram and QR-linked personal-account WhatsApp are implemented with automated checks.
Depends on phase 10; scheduled delivery also requires phase 11. Adapters remain
separate so Discord is independently usable.

`@poppet/channel-telegram` uses Bun HTTP and the Bot API for owner-only private
text chat with bot-token authentication and long polling. It verifies bot identity,
filters unsupported input, and implements the gateway's access, typing, and safe
reply-delivery contract. `gateway telegram setup <bot-id> <owner-id> --key-stdin`
saves protected settings without connecting. `tasks add --telegram-chat <owner-id>`
selects scheduled delivery through the existing destination resolver.

The gateway's optional polling operation checkpoints each update only after
acceptance or deliberate rejection. Migration 12 stores cursors by adapter and
bot account. Overload saves rejected input and its queue-full reply atomically,
so polling can reach controls without exceeding the inference queue limit.
Polling batches contain at most ten updates within a two MiB response cap.
Restart deduplicates any input committed before its cursor. Reply attempts
distinguish explicit rejection from uncertain outcomes. Shared protected settings helpers retain Discord's
existing file format and security checks.

Automated checks cover owner/private-chat restrictions, replay and restart,
account/adapter isolation, a full inbox, cancellation, text bounds, safe delivery,
setup and status redaction, and scheduled destination selection. A live owner-only
chat and scheduled delivery remain manual checks.

The chosen WhatsApp account model is a QR-linked personal account, using pinned
Baileys 7.0.0-rc14 under Bun 1.4.3. The unofficial client carries account-restriction
and protocol-compatibility risks; the Business Cloud API is outside this adapter.
`gateway whatsapp setup <account-phone> <owner-phone>` saves protected settings;
foreground-only `gateway whatsapp pair` links the account. Its scoped client owns
socket cleanup, identity checks, reconnects, and a separate protected SQLite key
store with atomic key batches. Unlinking clears session keys and stops the worker
adapter until paired again. Credential failures are isolated from other channels.

WhatsApp accepts owner-only private text, including chat with yourself. Persisted
outgoing identities suppress assistant echoes across lost acknowledgements and
restart. `tasks add --whatsapp-chat <owner-phone>` selects scheduled delivery through
the shared resolver. SDK receipts precede gateway acceptance, so bounded receive
buffering cannot guarantee recovery of pre-acceptance events after overload or a
crash. Accepted input and saved replies use existing gateway durability. SDK send
retries are disabled; ambiguous outcomes remain uncertain without automatic replay.

Automated WhatsApp checks cover binary key persistence and rollback, protected
storage, pairing reconnect/account mismatch/cleanup, owner and LID filtering,
self-chat echo suppression after restart, receive bounds, connection failures,
safe sends, offline setup, and scheduled flag validation. Imports, crypto,
auth serialization, protobuf, and QR rendering passed an isolated Bun smoke check.
Live pairing, protocol compatibility, owner chat, cancellation, and scheduled phone
delivery remain manual checks in the [WhatsApp guide](whatsapp.md#manual-validation).

Completion check for each adapter: authorized text chat resumes its own session
after restart, rejected senders cause no agent work, duplicate events do not
repeat execution, and delivery failures preserve the saved answer. Reuse shared
behavior tests and add platform-specific transport cases. Verify live setup and
delivery separately. Cross-platform session merging, multi-user memory sharing,
voice, and attachments remain outside these phases.

## Phase 13: Search past conversations

Implemented with automated checks. Real-model conversation recall remains a
manual check. Depends on persisted chat and the shared worker command path from
phases 4 and 9; phase 16 supplies readable titles. Phases 11–12 remain independent.

`chat search "query"` searches completed conversations without a model or provider
credentials. Tool-capable models receive `poppet_history.search_sessions`, backed
by the same store operation. Search includes user text and final assistant text
from completed CLI, scheduled, and messaging runs. Failed/interrupted inputs,
intermediate model responses, tool arguments/results, and provider continuation
are excluded. Historical messages remain untrusted data and cannot authorize
current actions. This uses the existing single-owner policy; adding users requires
an explicit access policy before exposing cross-session search.

Migration 9 creates a SQLite FTS5 index and backfills eligible messages. A completion
trigger indexes each successful exchange in the same transaction as its final
message and run result; indexing failure rolls back completion. Original messages
remain the source of truth. FTS5 support was confirmed in pinned Bun 1.4.3.
Queries are trimmed, nonempty plain text of at most 256 characters, with quoted
terms joined by AND and bound SQL parameters. FTS operators and wildcards are not
exposed. SQLite's Unicode tokenizer handles case and punctuation.

Results use relevance order with message ID as the stable tie-breaker. JSON
contains at most ten matches, each with session/message IDs, the current saved
title, a Unix-millisecond timestamp, role, and a bounded excerpt. A `truncated`
flag covers shortened excerpts or omitted matches. The serialized result respects
`POPPET_TOOL_BYTES`. Empty results need no model request. `chat show <session>`
provides the full saved exchange after a match.

Indexing and querying stay in `@poppet/store`, tool schema/validation in
`@poppet/agent`, and command parsing/output in `@poppet/cli`. Explicit dispatch
preserves namespaces, permissions, durable call records, cancellation, and run
budgets. Scheduled runs can search while retaining read-only notes permissions.
CLI search uses the running worker's protected socket and its configured budget,
or opens the store locally when no worker is available. No provider package,
new dependency, embeddings, search service, summaries, or memory writes are added.

Automated checks cover migration/backfill and rollback, completion indexing and
restart, excluded content, punctuation and Unicode queries, relevance and stable
ordering, empty results, result/byte limits, local/worker parity, and invalid
requests. A fake-model round trip verifies stored excerpts and durable calls,
including scheduled permissions, while existing notes tests continue to pass.
Run `bun run check`. Separately validate recall with a real model by finding an
older discussion with `chat search`, inspecting it with `chat show`, and asking a
new session to recall it using search.

## Phase 14: Explicit local Markdown skills

Implemented with automated checks. Live skill-assisted chat and a scheduled run
remain manual validation. Depends on chat, prompt budgeting, and durable tasks
from phases 4–7. Implemented after phase 13; skills do not add a model tool.

The agent's `Skills` service loads bounded UTF-8 files with directory, symlink,
hard-link, regular-file, and name validation. CLI inspection uses configuration
only. Local and worker creation paths load the file in the process owning the
store. Migration 10 persists nullable JSON snapshots on sessions and tasks;
occurrences copy the task snapshot. Saved content joins the run's instructions
and existing context budget without changing tool permissions. Automated checks
cover invalid files, local/worker command parity, restart, edits and deletion,
old-record migrations, task propagation, prompt budgets, and read-only scheduling.
No new package or dependency was added.

Store owner-written procedures at `<data directory>/skills/<name>/SKILL.md`.
Support `skills list`, `skills show <name>`, `chat new --skill <name> "message"`,
and `tasks add ... --skill <name>`. Select one skill explicitly when creating a
session or task. Existing sessions retain their selection. Messaging supports
`/new --skill <name> <message>` in Discord, Telegram, and WhatsApp, and
`/new <message>` to start without a skill. These queued commands create a fresh
session, snapshot the worker's local skill, and replace the conversation binding
while retaining prior sessions and history. `/status` reports the selected name.
Validation failures leave the binding unchanged and do not invoke a model.
Automated checks cover snapshot retention across restart and file changes,
deduplication, cancellation, recovery before binding, and delayed naming work.
Live messaging skill selection remains manual validation.
An example skill can describe how to summarize a note or write a weekly review
using tools Poppet already has. A skill does not add capabilities.

Use the directory name as the identifier and read the file as UTF-8 Markdown.
Keep the first version to a single file of at most 8 KiB; omit YAML metadata
parsing, referenced files, scripts, automatic matching, downloads, and agent-written
skills. Reuse the notes filesystem checks where practical without granting the
notes tools access to the skills directory. Reject traversal, symlinks, hard
links, invalid UTF-8, non-regular files, and oversized content. Missing roots list
as empty; an explicitly requested missing or invalid skill fails clearly before
model or task execution.

Resolve the selected file at creation and persist its name and full text as a
snapshot on the session or task. Add nullable snapshot fields through the normal
migration path; existing records have no skill. New task occurrences copy the
task's saved snapshot into their session. Editing or deleting a file affects
only subsequently created sessions/tasks, so an existing task does not silently
change behavior overnight. Creating a replacement task/session refreshes it.
Show the selected name and saved content in local inspection without exposing
credentials. Do not copy snapshots into unrelated sessions or global memory.

Keep skill loading in the agent package as a small Effect service, with CLI
commands and live-layer composition in the host. Extend creation request schemas,
worker socket handling, task/session persistence, scheduler session creation, and
test fixtures together. The process owning the store resolves the skill file so
CLI and worker use the same data directory and validation. Load one saved snapshot
into each run's instructions, below the base rules and above conversational data;
it cannot override explicit user requests, tool permissions, or scheduled runs'
read-only notes policy. Count its bytes in the existing context budget and reject
an oversized prompt before inference. Keep provider packages unchanged.

Implement the loader and local inspection first, then session selection and prompt
assembly, then task snapshots and scheduler propagation. Update configuration,
chat, tasks, storage, and architecture docs with the snapshot behavior. No new
package, dependency, marketplace, or generalized prompt-template system is needed.

Completion check: create a session and scheduled task with a small weekly-review
skill. Both receive its procedure; changing the file leaves their saved behavior
unchanged, while a newly created session sees the edit. An ordinary session has
no skill instructions.

Automated checks cover filesystem boundaries and limits, old-record migrations,
CLI/worker selection parity, missing skills, snapshot persistence across restart,
task-to-session propagation, context-budget failure, and unchanged tool permissions.
Use injected model requests to inspect the effective prompt, then run
`bun run check`. Validate one real skill-assisted chat and scheduled run separately.

## Phase 15: Read a supplied URL

Implemented with automated checks. Depends on the bounded, durable tool execution
from phase 5 and the expanded dispatch from phase 13. Independent of additional
messaging adapters and scheduled-result delivery.

`poppet_web.fetch_page` reads public HTTP(S) URLs explicitly supplied in the current
user message or saved task prompt. The host validates the initial URL against
that request's canonical URL set before executing any tool in the batch. History,
skills, notes, and fetched-page links cannot grant access. Redirect destinations
receive the same URL, DNS, and public-address checks.

The agent-owned `Pages` service uses an injected DNS/HTTP transport composed by the
CLI. The client connects directly to the validated literal IP while preserving
source Host, SNI, and TLS certificate/hostname verification. Every A/AAAA answer
must be public. Mapped IPv4, private, loopback, link-local, reserved, multicast,
translation/transition IPv6, credentials in URLs, and nonstandard ports are
rejected. Fresh connections avoid pooled sockets and ambient proxies. No cookies,
authorization headers, or provider credentials are sent.

Each read has a 15-second overall deadline, at most three redirects, and independent
1 MiB wire and decoded-body limits. gzip, deflate, and Brotli decoding is bounded.
Cancellation stops DNS and HTTP I/O. Unsupported types/encodings, invalid UTF-8,
HTTP failures, incomplete bodies, and pages without text fail without retry.

Bun HTMLRewriter structurally removes scripts, styles, navigation, hidden elements,
and other non-content material. A small pinned entity decoder complements the
native parser. Plain text and static HTML return final source `url`, nullable
`title`, extracted `text`, and `truncated` within the existing tool-result budget.
Tools retain durable records, namespaces, permission checks, and run budgets.
Scheduled runs may read their supplied URLs and still cannot save notes.

Automated checks cover URL authorization, mixed public/private DNS, rebinding,
redirect checks/limits, structural extraction, entities, Unicode and truncation,
body/decompression limits, unsupported responses, deadlines, cancellation, durable
results and failures, and a scheduled fake-model round trip. Production-client
loopback tests prove literal-address pinning, Host/SNI, TLS identity and trust,
proxy isolation, and cancellation without public-network test access. Run
`bun run check`. Live production retrieval passed on 2026-10-16 for example.com
HTML and RFC 9110 UTF-8 text, including bounded truncation of the latter. Live
model-assisted HTML/text summaries and a scheduled fetch remain manual validation.

See [chat](chat.md#read-a-supplied-url), [tasks](tasks.md#read-a-supplied-url),
[configuration](configuration.md#page-reading), and the
[architecture](architecture.md#supplied-page-reading) for the implementation.
Web search, browsers, JavaScript rendering, PDFs, authenticated pages, downloads,
linked-page crawling, persistent browser state, and caching remain outside scope.

## Phase 16: Session titles and Discord thread names

Implemented with automated checks. Live title inference and private-channel
Discord creation, renaming, and manual-edit races remain manual checks. Depends
on persisted chat and worker execution from phases 4 and 9; Discord naming also
depends on phase 10. Implemented before phase 13
so conversation search can display readable titles. Phase numbers retain their
existing references rather than prescribing implementation order.

Give each new session a readable title based on its initial prompt. Save a
single-line fallback immediately when the first user input is durably accepted,
before inference. Normalize whitespace, remove control characters, and truncate
at a Unicode-safe word boundary to at most 80 characters. Empty results use
`New conversation`. Titles are display metadata; IDs remain the stable command,
conversation-binding, and foreign-key identifiers. Duplicate titles are allowed.
Show titles in `chat sessions`, `chat show`, gateway status replies for a bound
session, and the planned conversation-search results.

After the first successful exchange, make at most one bounded, tool-free model
request to replace the fallback with a descriptive title of roughly 3–7 words.
Use the session's existing provider/model/workload through the generic model
interface; no separate title provider, model setting, or provider-specific logic.
Supply only a bounded excerpt of the original user prompt, before skill, memory,
or channel instructions are added. Treat it as data to name, with no authority
to execute instructions. Request plain text with a small output budget where
supported, validate and sanitize the response with the same 80-character limit,
and keep the fallback for empty, invalid, failed, or interrupted output. Use a
separate request with no conversation continuation, tools, or transcript writes.

Persist the title, its source, and whether automatic generation has been attempted.
Claim that attempt atomically before sending the request, so a restart cannot
repeat a possibly completed naming request. Failed main exchanges leave the
fallback and remain eligible after a later successful exchange. Once claimed,
title-generation failure is not retried automatically. Save generated titles only
if the session still has its fallback and no manual rename has intervened.
Add `chat rename <session> "title"` through both local and worker command paths;
a manual title wins over automatic work, including an in-flight request.

Complete and save the user's answer before generating its title. In messaging,
deliver the answer before starting optional naming work. Use the existing
serialized model access and a ten-second title-request deadline within the
owning process's scope. One-shot CLI execution prints the answer first, then
finishes the bounded naming attempt before exiting; this can extend exit time
and consumes additional provider usage. Worker shutdown and Ctrl-C may cancel
naming without changing a completed chat run. No detached process or persistent
background naming queue is needed. Keep naming failure separate from the main
run's status, provider pause state, and answer-delivery records. Record title
request usage separately from chat usage, marking missing usage as unknown.

Scheduled occurrence sessions use the task's existing name, shortened by the same
rules, and skip title inference. Existing sessions remain unnamed after migration
and display their IDs until manually renamed; do not run a bulk naming job or
change saved history. Title metadata updates must not change message ordering or
make an old conversation appear newly active.

For new Discord threads created by Poppet, replace the current fixed `Poppet`
name with the same fallback derived from the initiating message. When the session
receives a generated or manually assigned title, attempt to update its managed
thread too. Keep ownership and last confirmed bot-applied names in durable gateway
binding metadata, including enough creation provenance to recover a lost
acknowledgement of thread creation. A thread found during recovery is not automatically
managed merely because Poppet attaches to it. Never rename an unrelated existing
thread or a thread whose creation ownership cannot be established.

Before renaming, recheck authorization and fetch the current thread. If its name
differs from the last confirmed bot-applied name, treat it as a user override and
stop automatic synchronization. Recognized external name changes also disable
management; do not overwrite a user name when a delayed title result arrives.
Uncertain rename acknowledgements must be reconciled with the current name rather
than blindly retried. The session's local title stays independent when thread
management stops or an update fails. Missing permissions, rate limits, locked or
deleted threads, disconnects, and uncertain updates never fail the chat or repeat
model/tool work. Keep any transport retries bounded and inside the naming scope;
no perpetual rename reconciliation loop is needed.

Keep title metadata and atomic updates in `@poppet/store`, prompt-derived fallback
and model naming in `@poppet/agent`, and command parsing/help/live composition in
`@poppet/cli`. Extend the gateway/channel contract only with the conversation-name
capability and metadata needed by this feature. The gateway coordinates session
and managed-conversation titles; `@poppet/channel-discord` owns Discord name
sanitization, limits, permissions, API calls, and error classification. Other
adapters can omit renaming without blocking chat. Inference-provider packages
remain unchanged. Update session creation callers, store/schema migrations,
worker socket requests, gateway bindings, adapter fixtures, and inspection output
together; no new dependency is required.

Implement in three reviewable steps: first persisted fallback/manual titles and
all session creation paths; then optional model-generated titles with scoped
execution and usage accounting; then managed Discord thread naming and recovery.
Update chat, storage, tasks, Discord, worker, and architecture documentation when
implemented. No automatic retitling on later messages, title-based session lookup,
retroactive thread renaming, or separate naming service is needed.

Completion check: a CLI session immediately has a fallback and gains a concise
title after its first successful exchange. Manual names survive later turns and
restart. A Discord mention creates a named thread and, after the answer is sent,
updates it to the generated title. Editing the thread name while naming is in
flight preserves the user's edit. An attached pre-existing thread keeps its name.
A failed naming request or forbidden Discord rename still leaves a successful,
inspectable answer and usable fallback title.

Automated checks cover old-record migrations, Unicode/control-character handling,
empty and long prompts, duplicate titles, all session creation paths, task-name
reuse, local/worker command parity, restart and atomic attempt claiming, manual
rename races, bounded model requests, isolated continuation and usage, cancellation,
and unchanged completed-run outcomes. Fake-channel tests cover thread creation
and lost acknowledgements, management provenance, user edits before an update,
permission/rate-limit failures, uncertain rename reconciliation, and independent
behavior when an adapter has no naming capability. Run `bun run check`. Separately
validate live title inference and Discord creation/renaming in the private test
channel, including manual edits and the platform's non-atomic rename race.

## Validation

Use behavior tests with injected `Model`/auth layers and a controllable clock.
Run shared text and tool-exchange cases against each provider adapter, including
stream completion, cancellation, and continuation preservation.
Exercise persistence against temporary SQLite databases. Keep live account checks
focused on subscription access, token renewal, one tool round trip, and the
completed assistant flow. Do not claim these live checks passed from fake-provider
tests.
