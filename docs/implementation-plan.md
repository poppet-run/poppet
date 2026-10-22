# Poppet implementation plan

[Documentation index](index.md)

Status: Phases 1–21 implemented with automated checks. Phase 21 also has a pinned local-browser check; live-model CLI and messaging browser completion remain manual. Phase 22's Stage 22a compatibility probe is implemented and passed the attended accessibility-only Calculator trial without inference, including the owner-run permission scenarios. Stages 22b–22c remain unimplemented. Phase 20 live MCP validation remains manual. macOS login startup, physical sleep/wake, live unattended inference, live title inference, live conversation recall, live skill-assisted chat and scheduling, live URL-assisted chat and scheduling, live Discord behavior, live scheduled-result delivery, live Telegram behavior, live WhatsApp behavior, live web-search-assisted inference, live scheduled research delivery, and live chat task management require manual validation.

Phase 12's Telegram and WhatsApp adapters are implemented with automated checks. Discord thread chat, scheduled-result delivery, conversation
search, local Markdown skills, supplied-URL reading, and phase 16 naming are
implemented.

[MCP server support](#phase-20-mcp-server-support) is implemented for local stdio tools. See the [MCP guide](mcp.md) for setup and remaining live validation.

[Browser automation](#phase-21-browser-automation-with-agent-browser) uses
agent-browser and text snapshots. [Computer use](#phase-22-computer-use)
starts with a separately scoped accessibility-only trial.

[Change-aware monitoring](#phase-23-change-aware-monitoring) is implemented with
automated checks. Real-model monitoring and live change delivery remain manual.

[Editable tasks and snoozing](#phase-24-editable-tasks-and-snoozing) is implemented
through editing, skip-next, snooze, and run-now, with automated checks. Real-model
intent handling and live messaging validation remain manual.

Command execution and approval are implemented in [Phase 31](#phase-31-command-execution-and-approval),
with explicit per-run grants and separate opt-ins. Browser login state, doctor
and the workflow trials remain planned work. Their notes do not authorize implementation.

| Phase                                                                      | First deliverable                                          | Follow-up stages                                                   |
| -------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| [25: Documents and voice](#phase-25-documents-and-voice-messages)          | Owner-sent Telegram text attachments                       | Text-based PDFs, then opt-in voice transcription                   |
| [26: Project context](#phase-26-context-for-individual-projects)           | Explicit project instructions saved with a session or task | Project facts and selected notes                                   |
| [27: Reviewed actions](#phase-27-actions-the-owner-can-review-and-approve) | Review and approve one proposed note write                 | One supported external action, then scheduled proposals            |
| [28: Browser login state](#phase-28-browser-login-state-across-requests)   | One explicitly selected, protected browser profile         | Attended login, reuse, inspection, and clearing                    |
| [29: Doctor](#phase-29-a-useful-poppet-doctor)                             | Read-only local health report with next steps              | Worker observations and stable JSON output                         |
| [30: Workflow trials](#phase-30-calendar-briefings-and-weekly-reviews)     | Existing-tool capability checks                            | Calendar briefings and weekly reviews without a native integration |
| [31: Command execution](#phase-31-command-execution-and-approval)          | Opt-in commands with exact, one-time owner approval        | Narrow automatic reads, scheduled proposals, advisory model review |

See [future priorities](future-priorities.md) for the priority order and workflows
to try using existing tools. The phase numbers organize delivery; independent
work such as doctor need not wait for every earlier phase.

Updated: 2026-10-22

Storage history: the unreleased base schema is consolidated into version 1 in
one timestamped initial migration. Phase 23 adds migration 2 without resetting
version-1 data. Phase 24 adds migration 3 for task controls and occurrence snapshots,
retaining version-1/version-2 data. Migration numbers and
upgrade/backfill checks in the phase notes below describe the original work,
not a supported upgrade path. See [storage](storage.md#schema-and-saved-records)
and [development](development.md#store-migrations) for the current setup.

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
| MCP TypeScript SDK                  | Stdio client and protocol lifecycle; verify Bun compatibility and pin a supported release during implementation        | MCP server support        |
| agent-browser CLI and Chromium      | Local browser automation; agent-browser 0.39.1 and Chrome for Testing 155.0.8059.84                                    | Browser automation        |

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
  discovers models and resolves one provider/model to `ModelOperations` for inference.
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
composition. Fake model operations require no account. The public Go and OpenRouter
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
persist them, assemble bounded context, resolve the saved model through `ModelResolver`, and
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
oversized context/output, cancellation, early consumption, and a five-minute
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
and aggregate text limits bound the run. The absolute run deadline is five
minutes, and model requests are never retried or switched to a fallback.

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
The CLI supplies runtime paths and the data-directory selector and selects the platform.
The LaunchAgent saves absolute runtime paths and `POPPET_DATA_DIR`; the worker
reads ordinary settings from `config.json` at startup. It starts at login and keeps the process running with
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
unverified. See the [setup and manual path](gateways/discord.md).

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
delivery remain manual checks in the [WhatsApp guide](gateways/whatsapp.md#manual-validation).

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
Web search remains outside this phase and is planned in phase 17. Browsers,
JavaScript rendering, PDFs, authenticated pages, downloads, linked-page crawling,
persistent browser state, and caching remain outside scope.

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

## Phase 17: Web search

Implemented with automated checks. Live search-to-page inference and a scheduled
research summary delivered through messaging remain manual validation. Depends on
the durable tool loop from phase 5 and protected page reader from phase 15.
Independent of phases 18–19.

`poppet_web.search_web` accepts a trimmed, nonempty query of at most 512 UTF-8
bytes. A single Brave Search backend returns at most five source titles,
canonical public HTTP(S) URLs, and snippets in backend order, with a `truncated`
flag. Invalid URLs, private literal addresses, and URLs that cannot fit are
omitted; long text is shortened safely within `POPPET_TOOL_BYTES`. Empty results
are successful. The service adds no ranking model, cache, or search-provider registry.

Search is opt-in through `webSearch` in `config.json`, overridden by
`POPPET_WEB_SEARCH`. `web login [--key-stdin]`, `web status`, and `web logout`
reuse protected credential storage under `auth/brave-search.json`, independently
of inference providers. `POPPET_BRAVE_SEARCH_API_KEY` overrides that saved key.
Missing credentials or disabled search omit the tool while ordinary chat and
page reading remain available. Invalid enabled setup fails clearly. Keys never
enter general configuration, LaunchAgents, transcripts, or diagnostics. Restart
an existing worker after changing settings or credentials.

Platform fetch sends the query and fixed options to Brave's fixed HTTPS endpoint,
with a separate authentication header and redirect rejection. It adds no
conversation, notes, memory, skills, or inference credentials as extra request
context. A 15-second overall deadline, streamed 1 MiB response limit, strict UTF-8
and schema validation, and cancellation bound the operation. Authentication,
rate-limit, HTTP, malformed-response, and network failures become sanitized
agent errors without retries or backend fallback. Search failures do not pause
inference providers.

A successfully completed and journaled search adds only the URLs actually
returned to the model to the current run's canonical page allowlist. A later
model turn may fetch them through the existing DNS, literal-IP, redirect, TLS,
body, and deadline checks. Whole-batch validation still runs before execution,
so a search and previously unauthorized fetch in one batch fail before either
executes. Snippets, page links, omitted results, history, and saved search results
from previous runs grant no access. Grants are discarded at run end and never
reconstructed from transcript text.

Interactive CLI, worker, and messaging requests share the same service and
permission rules. Scheduled runs may search and read returned sources while
notes and memory remain read-only. Results are untrusted source data, never
mutation authorization. Instructions require citations and distinguish snippets
from pages actually read. Existing durable calls, run budgets, and cancellation
remain authoritative.

`@poppet/agent` owns schemas, the service contract, result budgeting, dispatch,
and run-local grants. The CLI owns the Brave request implementation, credential
commands, and live composition using existing config/credential packages.
Provider packages stay unchanged. No new dependency or database migration was
needed. Chat, tasks, configuration, CLI, and architecture docs describe setup,
query disclosure, failure behavior, and source permissions.

Automated checks cover disabled/missing setup, file/environment precedence,
credential independence and redaction, malformed arguments and responses,
empty results, count/byte/body limits, Unicode truncation, deadlines,
cancellation, durable results/failures, and scheduled read-only execution.
Fake-model checks cover search-to-page use, same-batch rejection, snippet and
omitted-result rejection, and grant isolation across runs. Existing page-reader
SSRF and connection checks remain in place. Run `bun run check`. Separately
validate one live research chat and scheduled delivered summary, including source
citations, using the setup in [configuration](configuration.md#web-search).

## Phase 18: Task management through chat

Implemented with automated checks. Live chat creation, inspection, pause/resume,
and a delivered occurrence remain manual validation. Depends on durable tasks,
worker commands, and destination validation from phases 7–12. Independent of
web search and deeper conversation recall.

`poppet_tasks.manage_tasks` supports `create`, `list`, `show`, `pause`, and `resume`
in tool-capable interactive CLI and authorized messaging chat. It reuses the
existing repository and scheduler. Scheduled runs do not receive the tool and
fabricated calls are rejected before execution, including read actions. Editing,
deleting, clearing, running immediately, retrying, provider resumption, and
active-run cancellation remain outside this tool; existing CLI commands retain
those functions.

Only the owner's current explicit request authorizes a mutation. Tool and base
instructions reject authorization from history, skills, notes, pages, and tool
results, and require clarification of ambiguous identity, prompt, time, or
timezone. Trusted host context supplies interactive/scheduled origin, the current
run's provider/model/workload, and any current-conversation resolver. The model
cannot supply owner/account IDs, arbitrary channel IDs, or inference selection.
No keyword classifier, additional permission model, or confirmation flow was added.

Creation saves a self-contained prompt, explicit name, future offset-qualified
one-off timestamp or five-field cron with an explicit timezone, and an optional
explicitly selected skill snapshot. The host clock supplies current UTC time for
relative dates. The existing parser and occurrence calculator validate schedules.
Occurrences start in fresh sessions with no implicit copy of the creating chat.
Local results are available everywhere; `here` is available only when a gateway
supplies the current authorized destination. The gateway rechecks owner/access
and stores the existing destination snapshot. Future delivery retains the usual
rechecks and durable queue.

List returns bounded task summaries with a stable ID cursor. Show returns the
saved prompt, selection, schedule, destination, skill name, and bounded recent
occurrence status. Inspection fits `POPPET_TOOL_BYTES` and flags omitted/shortened
content without returning full answers or unbounded history. Pause and resume
use stable task IDs and retain existing behavior: pending work is cancelled,
active work continues, and missed recurring times are not replayed. Mutation
receipts identify the task, saved state, timezone-qualified schedule, next time,
and destination. Success is claimed only after a durable receipt.

`@poppet/agent` defines strict arguments and the narrow `ChatTasks` capability;
`@poppet/tasks` implements preparation, repository operations, bounded inspection,
and recovery. The CLI composes it for local and worker execution, and the gateway
supplies current-conversation provenance directly to the run. Preparation of the
whole batch finishes before any tool executes. No agent-to-tasks import cycle,
loopback worker request, or reacquisition of the active agent permit is needed.
Task tools share the repository command lock with worker commands and occurrence
claiming. The existing timer picks up new work.

`Store.commitToolCall` commits a synchronous task operation and its tool
receipt/message in one shared SQLite transaction. Receipt failure rolls back
the task. Migration 13 adds nullable creating run/call provenance and a unique
index; existing tasks retain no tool origin. A repeated completed call returns
its original saved receipt. Changes survive later inference failure or interrupted
answers, and uncertain storage outcomes remain inspectable without automatic
replay. No new dependency or scheduling system was added.

Automated checks cover argument/authority-field rejection, old-record migration,
local/worker parity, skill snapshots and missing skills, invalid/past times,
existing DST calculator behavior, bounded/cursor-based inspection, destination
revocation, scheduled rejection of all actions, atomic rollback, duplicate-call
recovery after restart, cancellation during destination lookup, and changes
surviving later model failure. A shared-agent test pauses a task while its running
occurrence waits for that agent, without deadlock or interrupting the occurrence.
Run `bun run check`. Separately validate live chat task creation, inspection,
pause/resume, and one delivered occurrence using the [task guide](tasks.md#manage-tasks-through-chat).

## Phase 19: Deeper conversation recall

Implemented with automated checks. Real-model recall of an older discussion
remains a manual validation step. Builds on phase 13 search and phase 4 chat;
independent of phases 17–18.

`poppet_history.read_session` accepts `session_id` and nullable
`around_message_id` / `after_message_id`, never both set. With no anchor it starts
at the earliest eligible message. Around a match it selects up to four preceding
messages, the match, and five following messages in chronological session order.
The byte budget can reduce this window while preserving the match. Missing
sessions and invalid or ineligible anchors fail clearly.

`Store.readSession` uses indexed eligible IDs and the shared search projection
over original saved messages. It returns only completed-run user text and final
assistant text, excluding failed/interrupted and in-progress exchanges,
intermediate output, tool data, reasoning, continuation, and context snapshots.
SQL bounds rows and text before they reach the agent. No index, transcript copy,
summary, dependency, or schema migration was added.

Results include the session ID, current title, and at most ten messages with
message ID, role, timestamp, text, and a per-message truncation flag. The entire
JSON result fits `POPPET_TOOL_BYTES`, preserving Unicode code points. The overall
`truncated` flag marks shortened or omitted content. `nextAfterMessageId` advances
past the last returned message, even when shortened, and is null when no later
eligible message remains. Around-message results can still omit earlier context.
Stable anchors avoid duplicate pages when new exchanges complete.

The agent owns strict argument validation, namespaced dispatch, and instructions.
Recall uses existing durable calls, cancellation, and call/context budgets in
interactive and scheduled runs. Instructions direct the model to search first
when needed, read around a match, page only as needed, cite saved statements by
session/message IDs, and distinguish them from current facts.

Historical text stays untrusted. Recalled URLs grant no page access and never join
web-search grants. Scheduled note/memory/task mutations remain blocked. Reading
never resumes the source session, changes its title/activity, imports its
continuation, or writes global memory. The existing single-owner access policy
still applies. `chat show` and its local/worker inspection behavior are unchanged;
model recall needs no CLI or socket command.

Automated checks cover search/read eligibility parity, chronological ordering,
anchor/session validation, empty sessions, paging around a match, appended
exchanges, Unicode and oversized-message truncation, byte limits, cursor progress,
durable calls, cancellation, and unchanged stored history. A fake-model search-to-
read round trip verifies follow-up context and scheduled read-only behavior,
including rejection of mutations and recalled-URL fetches. Run `bun run check`.
Separately validate with a real model by searching for an older decision, reading
its surrounding discussion, and answering a follow-up using the saved context.
See [conversation context](chat.md#read-conversation-context).

## Phase 20: MCP server support

Implementation uses `@modelcontextprotocol/client` 2.3.1, `@poppet/mcp`, the
agent's provider-independent `ExternalTools` contract through a host adapter, and migration 14 for saved
server/tool identity. The strict JSON-string argument wrapper preserves original
schema validation, including optional fields. Connections start lazily, stay with
the worker, and close with their owner. Failed connections need an owner restart;
no call is retried. Bounds, supported schemas, credential references, inspection
commands, and the remaining live completion checks are documented in [MCP tools](mcp.md).

Implemented with automated fixture-server and injected-model checks. Live-model,
messaging and scheduled-read validation remains manual. Depends on phase 5's tool loop, phase 4's durable records, and phases 8–9's
shared worker ownership. Reuses phase 7's scheduled-run permissions and the existing
messaging agent path.

Make Poppet an MCP client that connects to explicitly configured local stdio
servers and exposes allowed tools to the model. Use the official TypeScript SDK
for protocol negotiation and transport. Start with tool discovery and invocation;
remote HTTP/OAuth, MCP resources and prompts, sampling, elicitation, media, server
installation, and exposing Poppet itself as an MCP server are outside this phase.
See the [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
and [SDK client documentation](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect).

Keep connections, discovery, protocol validation, and process cleanup in
`@poppet/mcp`. The CLI composes its live layer into the process running the agent.
Inject a provider-independent tool interface into `@poppet/agent`; keep provider
adapters generic and avoid a second model/tool loop. Use scoped subprocesses and
argument arrays without an implicit shell. Local servers run executable code with
the host account's permissions; an MCP tool allowlist is not an OS sandbox.

Add validated server entries to file configuration with stable IDs, executable,
arguments, optional working directory, named environment/secret references, and
explicit tool allowlists. MCP is disabled unless the owner configures and enables
a server. Preserve file defaults and environment overrides; never put secret
values in general config, LaunchAgents, model prompts, inspection output, or logs.
Pass a minimal child environment plus only explicitly selected credentials,
rather than inheriting every provider/channel secret. The model cannot add
servers, change commands, install packages, or expand permissions. Worker config
changes take effect after restart, following existing configuration behavior.

The worker owns server processes when it owns the agent. A standalone CLI run uses
scoped local connections; a CLI request routed through the worker uses those
connections. Startup is bounded, and one unavailable server produces a clear
diagnostic without disabling built-in tools. Owner shutdown, startup failure,
and scoped CLI cancellation release clients and reap their children. Reconnection
may serve a later request but never replays an earlier tool call automatically.

Expose only discovered tools on each server's allowlist. Bound discovery pages, tool
counts, descriptions, schemas, and protocol messages before unbounded buffering.
Map server/tool identities to stable provider-safe names with an exact reverse
mapping, rejecting collisions with built-ins or other servers. Validate the
original input schema and model arguments, and handle provider strict-schema
requirements without silently weakening validation. Unsupported schemas or
capabilities receive an actionable diagnostic. Snapshot the allowed catalog for
each run; server list-change notifications cannot add permissions during a run.
Tool definitions count toward the existing context budget.

Maintain separate interactive and scheduled allowlists. Scheduled tools must be
an owner-reviewed read-only subset, disabled by default; server annotations such
as `readOnlyHint` cannot grant access. Interactive mutations require an explicitly
allowed tool and the owner's current request. Server descriptions and results
remain untrusted data. They cannot authorize built-in memory/note/task mutations,
change permissions, or grant page access. URLs returned by MCP do not become
web-search grants. Poppet forwards tool arguments and selected credentials; it
does not inject conversation history or global memory into MCP requests.

Dispatch MCP calls through existing durable tool records, batch validation, call
budgets, cancellation, and timeouts. Records must identify the server and original
tool independently of an in-memory discovery catalog. Bound text and structured
JSON results by `POPPET_TOOL_BYTES`, preserving Unicode and valid serialization,
and explicitly mark omitted or shortened content. Do not automatically fetch
resource links or forward unsupported media. Distinguish tool-reported errors
from transport/protocol failures and never report a failed operation as a
successful mutation. A timeout, disconnect, or cancellation after dispatch can
leave effects unknown; preserve an uncertain durable outcome without automatic
retry or replay, including after restart.

Add `mcp servers`, `mcp tools <server>`, and `mcp status` for configuration,
discovery, effective permissions, and connection diagnostics. Pure config/status
inspection must not launch a server or require a model. Explicit tool discovery
uses the owning worker when available and scoped local connections otherwise.
Do not expose an arbitrary tool-execution socket command. Extend config schemas,
runtime composition, agent contracts/dispatch, inspection, and fixtures together.
Add an MCP guide and update configuration, CLI, worker, tasks, and architecture
docs when implemented.

Automated checks use a fixture stdio server to exercise real protocol startup,
paginated discovery, invocation, errors, cancellation, and child cleanup. Cover
name collisions, unsupported schemas, strict-schema provider compatibility,
unknown/denied tools, server-driven catalog changes, default-denied scheduling,
explicitly allowed scheduled reads, blocked mutations, secret/environment
isolation, bounded discovery/results, Unicode, and unavailable servers. Verify
durable records, uncertain outcomes without replay, local/worker parity, and
that untrusted MCP output grants no built-in mutation or page-fetch authority.
Run `bun run check`.

Completion check: connect one trusted local server, inspect its allowed tools,
and complete a real-model tool round trip through CLI and messaging. Separately
verify an explicitly allowed scheduled read and worker shutdown without orphaned
server processes. Remote transports and broader MCP capabilities remain later
work.

## Phase 21: Browser automation with agent-browser

Implemented with fixture and injected-model checks, plus a standalone check with
agent-browser 0.39.1 and Chrome for Testing 155.0.8059.84 on Apple silicon macOS.
Live-model CLI/messaging completion and live worker cancellation/shutdown remain
manual. See [browser automation](browser.md) for setup and validation.

Native MCP handshake and selected schemas passed a compatibility probe. The
implementation uses the plan's fixed adapter because native tools expose launch
and session overrides, and their CLI lifecycle detaches the daemon. `@poppet/browser`
owns the pinned native daemon and sends validated commands over its private Unix
socket. It also owns browser settings, errors, and tools, which the CLI adapts to
the agent's external-tool contract. No provider, external dependency, or storage
schema changes were needed.
Windows support, persistent login state, and computer use remain outside scope.

Depends on phase 5's tool loop, phase 4's durable records, phases 8–9's
worker ownership, and phase 20's external-tool integration. Reuses the existing
messaging agent path. Browser automation is optional and interactive-only in this
phase; every scheduled run receives no browser tools.

Let Poppet navigate JavaScript websites, inspect compact accessibility snapshots,
and interact with elements through agent-browser. Start with local Chromium,
text results, and a fresh isolated browser session for each run. Navigation,
snapshots, clicks, form filling, bounded key presses, scrolling, and close are the
initial operations. Use snapshot element references for interactions and refresh
the snapshot after navigation or a stale-reference error. Do not guess targets or
silently replay an interaction that may already have changed the page.

First verify the native `agent-browser mcp --tools core` server against Poppet's
MCP handshake, strict schema validation, and bounded text results. Its default
profile contains more operations than this phase permits, so use an explicit
Poppet tool allowlist as well as a daemon-enforced action policy. Reuse
`@poppet/mcp` and the existing `ExternalTools` contract where they meet the session
and lifecycle requirements below. If native MCP cannot enforce those requirements,
use a small fixed-command CLI adapter through the same external-tool hook. Keep
one model/tool loop and compose browser tools alongside existing MCP tools.
See the [agent-browser commands](https://agent-browser.dev/commands#mcp-server),
[sessions](https://agent-browser.dev/sessions), and
[security controls](https://agent-browser.dev/security).

Keep browser process/session management and command validation outside provider
adapters. Extend the host-to-tool context only as needed to bind browser work to
the current session and run. Poppet chooses an opaque browser session identity;
model arguments cannot select another session, attach to an existing daemon, or
override launch settings. Native MCP's optional session arguments must not bypass
this binding. Keep browser state isolated across CLI, worker, and messaging runs,
even though the worker retains its general MCP connections.

Add owner-controlled file configuration for enablement, the installed executable,
and allowed domains, preserving file defaults and environment overrides. Disabled
or unavailable browser support leaves ordinary chat and existing tools available
with an actionable diagnostic. Install the pinned CLI and its supported Chromium
build explicitly during setup; never install or upgrade them from a model call.
Prefer an absolute executable path for the background worker. Configuration
changes take effect after restart, following existing worker behavior.

Poppet fixes command arguments, working directories, security settings, and a
minimal child environment. No shell, arbitrary CLI flags, scripts, plugins, or
inherited provider/channel credentials are exposed. Prevent ambient agent-browser
configuration from enabling other profiles, providers, or capabilities. Use a
private runtime directory and namespace so other chats or ordinary agent-browser
invocations cannot reuse the run's browser state. Persistent profiles, imported
cookies, auth-vault access, saved login state, and attaching to the owner's daily
browser are outside this phase.

Require an explicit nonempty owner-configured domain list. Exact hostnames enable
agent-browser's domain restrictions before the first navigation; `"*"` explicitly
allows all HTTP(S) hosts, including localhost and private networks, and omits
daemon domain filters while retaining WebRTC blocking through fixed host-owned
launch settings. Deny unlisted actions in both modes. Page text, discovered
links, model arguments, and search results cannot change the configured mode.
Validate navigation URLs as HTTP(S), without embedded credentials. Verify that
redirects, new tabs, and subresource requests obey the configured domain mode,
and fail closed when the selected launch mode cannot enforce them. Document any
required CDN domains and the pinned release's network limitations. Browser
traffic does not pass through `fetch_page`'s DNS/IP checks, and a hostname
allowlist does not provide an operating-system network sandbox.

Browser interactions can submit forms or change external state. Perform them
only for the owner's current explicit request; never describe generic clicking
or typing as read-only. Page content and tool results remain untrusted data and
cannot authorize other actions, change permissions, mutate notes/memory/tasks, or
grant `fetch_page` access. Return the current URL with observations so answers can
cite pages actually inspected. Arbitrary JavaScript evaluation, downloads,
uploads, clipboard access, network interception controls, screenshots, and PDF
output are outside the initial tool set. A general pause-and-approve workflow is
also later work, not an implied capability of this phase.

Use existing durable tool records, whole-batch validation, call/model-turn budgets,
and uncertain outcomes. Bound browser startup, each command, and captured stdout
and stderr before unbounded buffering. Return validated text/JSON within
`POPPET_TOOL_BYTES`, preserving Unicode and marking shortened content. Keep page
data and command failures out of raw diagnostics. Check the existing MCP startup
and invocation deadlines against real browser startup and navigation; change only
the browser-specific limits if required. Cancellation, timeout, run completion,
startup failure, and worker shutdown must close the run's daemon and browser as
well as its command subprocesses. Closing only the short-lived CLI is insufficient.
Never retry or resume an uncertain browser action automatically after restart.

Update configuration decoding, host composition, external-tool context, cleanup,
and fixtures together. Add a browser setup/usage guide and update configuration,
chat, worker, tasks, MCP, and architecture docs when implemented. Keep the provider
message format and storage schema unchanged unless the integration proves a
specific need; text-based browser use requires no image support.

Automated checks use an injected model and a controlled command/MCP fixture.
Cover disabled and unavailable setup, config precedence, denied actions and
domains, session-override rejection, state isolation across runs, malformed and
oversized output, Unicode truncation, stale references, deadlines, cancellation,
daemon/browser cleanup, durable uncertain outcomes without replay, and omission
of browser tools from scheduled runs. Verify that page content cannot grant
mutation or page-fetch authority. Exercise a small local test site with the pinned
real browser for navigation, redirects, blocked subresources, form interaction,
and isolation; keep external sites and live inference out of automated fixtures.
Run `bun run check`.

Completion check: complete one explicitly requested browser workflow with a real
model through CLI and an authorized messaging conversation, including text
extraction and an intentional form action on a disposable test site. Inspect the
saved calls, verify denied navigation, cancel a running workflow, and confirm no
run-owned daemon or browser remains after cleanup or worker shutdown. These live
checks remain manual and must pass before describing browser support as complete.

## Phase 22: Computer use

Stage 22a's isolated compatibility probe is implemented and passed its attended
Calculator checks. See the [probe guide](computer-use-probe.md) for commands,
boundaries, and verified results. Stages 22b–22c are planned only. No driver
installation, permission changes, or further runtime integration are authorized
by this plan alone.
The first deliverable is an attended macOS accessibility trial, not general
desktop automation. Phase 21's outstanding live checks remain prerequisites for
claiming the combined browser/computer feature set is ready. Planning and an
isolated compatibility probe need not wait for those checks.

### Trial scope and success condition

Use the local Mac and Calculator, `com.apple.calculator`, with the owner present.
The owner opens Calculator in basic mode on the current Space and sets aside its
current calculation. This avoids provisioning a VM or building a test app before
we know whether the integration works. It does not isolate the desktop: Calculator
state is shared with the owner and other automation.

Start with one window, one run, and two model-facing operations: read its
accessibility snapshot and press a button identified in that snapshot. First
complete a read-only observation. Then explicitly request clearing the display,
calculating `12 + 7`, and reading back `19`. The answer must use the observed
display, not the model's own arithmetic. A wrong display is a failed trial even
when every tool call reports success.

The trial is macOS on Apple silicon, standalone CLI, and a fresh chat only.
Worker-backed requests, messaging, scheduling, resumed chats, and the interactive
prompt receive no computer tools. Other operating systems and Intel Macs need
their own evidence before support is claimed. There is no automatic escalation
when an application exposes an incomplete tree or refuses an AX action.

Screenshots, image forwarding, pixels, native key events, text entry, menus,
clipboard access, app launch/termination, window management, files, browser/CDP
tools, recording, history hydration, remote desktops, and VM provisioning are
outside the trial. Typing and broader application support require a later plan
after this trial produces evidence.

### Upstream evidence and candidate runtime

Research checked on 2026-10-21. Use
[Cua Driver 0.38.0](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.38.0)
as the candidate, not a verified dependency. Record the exact macOS release asset,
checksum, signature identity, OS version, and exported schemas in the compatibility
probe. Pin the tested executable; no latest-version lookup, installation, or
upgrade occurs during a chat. The generated upstream documentation can differ
from that release, so the installed contract must pass the gates below.

Relevant upstream contracts:

- Bare macOS MCP proxies to the shared app daemon. `mcp --direct` instead owns
  its runtime and TCC attribution. Prefer direct stdio for the trial; do not
  silently attach to or stop an existing daemon.
  See [MCP launch modes](https://cua.ai/docs/cua-driver/reference/cli/serve-and-configure).
- `standard` permits broad input. `bounded` requires an approved capability
  manifest; tool and resource restrictions apply inside the driver.
  See [permissions](https://cua.ai/docs/cua-driver/guides/permissions).
- Window state can omit screenshots. Element tokens belong to a window snapshot
  and become stale after a replacement snapshot. `get_accessibility_tree` is
  broad desktop discovery, not the per-window read needed here.
  See [window tools](https://cua.ai/docs/cua-driver/reference/mcp-tools/apps-windows-and-screen).
- Element clicks support AX actions, while other click forms and typing can use
  native events. Fix the trial to a left-button AX `press` and verify that route.
  See [input tools](https://cua.ai/docs/cua-driver/reference/mcp-tools/click-and-type).
- Sessions share the desktop; their labels do not grant isolation or authority.
  See [runtime ownership](https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works).

These are compatibility requirements, not claims that Poppet or the candidate
binary has already enforced them. If direct mode cannot provide reliable
permissions, bounded access, and cleanup, stop the trial and revise the runtime
choice. Do not add a shared daemon, app wrapper, SDK bridge, or VM as an implicit
fallback.

### Existing Poppet contracts to reuse

The agent already has scoped `ExternalTools.snapshot`, whole-batch argument
preparation, sequential execution, saved external server/tool identities,
cancellation, uncertain outcomes, and run budgets. The provider contract accepts
text tool results and does not support image messages. No provider change or
storage migration is needed for this trial.

`@poppet/mcp` already owns SDK negotiation, schema validation, capped stdio,
text/JSON results, and awaited child teardown. Its general connections stay with
their process owner and its tools expose the discovered argument schema. That
does not by itself bind a driver to one run/window or force screenshot-free
arguments. Dropping image blocks from a result also does not prevent capture.
Its generic tool-error message does not preserve driver refusal codes. Decode
the driver's bounded outcome in the adapter before generic result formatting so
stale tokens, denied actions, and unknown effects do not become indistinguishable.

Use MCP as the driver protocol and the existing agent loop. The first probe
should test the existing MCP client and catalog helpers before adding a computer
adapter. Prefer reusing the scoped transport and schema/result helpers through
narrow exports if needed. Do not weaken general MCP schema validation or change
its connection lifetime to accommodate one driver. Do not add another MCP SDK,
agent loop, native accessibility implementation, or generic approval framework.

### Stage 22a: Compatibility probe, without inference

The probe passed against checksum-verified Cua Driver 0.38.0 on Apple silicon
macOS 27.0.1 with Calculator 12.0 on 2026-10-21. All original input/output schemas
and strict wrappers passed. The shared MCP compiler accepts only Cua's reviewed
linear snapshot-token pattern and valid required-only union branches; it retains
runtime assertions and existing schema limits without stripping keywords.
The normal Calculator sequence, stale tokens, denied app/argument access, session
revocation, startup rejection, cancellation, EOF, and forced idle-owner exit passed.
The owner also verified the normal trial from Terminal without Screen Recording,
locked-screen refusal, and revoked Accessibility before app access. This result
does not establish live-model behavior or forced owner exit during an in-flight
real desktop action. The probe exports private schemas and content-free outcomes.

The ordered checks define the explicitly invoked self-check, outside the
automated test suite. Its fixed calls run against the pinned real driver and
disposable Calculator state; automated tests use synthetic fixtures.

1. Inspect the candidate's needed schemas without desktop calls. Check the input
   and output shapes against Poppet's current schema compiler and strict provider
   wrapper; save a sanitized fixture, not desktop content.
2. Launch a directly owned runtime with bounded mode, a private manifest and policy,
   and no ambient credentials or launch options. Restrict resources to Calculator
   windows, disable full-desktop access, and permit only the underlying observation,
   AX press, and lifecycle operations actually needed by the host. Negotiate MCP
   and verify real discovery stays within Poppet's limits before any desktop call.
3. Resolve Calculator using a host-fixed bundle ID. The pinned driver classifies
   even filtered `list_windows` as full-desktop access, so keep enumeration denied.
   Use only `launch_app` with `bundle_id: "com.apple.calculator"` as trusted setup,
   without URLs, files, extra arguments, alternate instances, or app termination.
   Select exactly one eligible window and bind its process/window identity. Prove that unfiltered
   enumeration and another application's window are denied or prevented before
   any content reaches Poppet. Merely filtering a broad result afterward is not
   enough for the intended observation boundary.
4. Read a bounded tree with `include_screenshot: false`, no screenshot output path,
   and structured elements plus tree text. The pinned driver omits the read-only
   display from its actionable element array. Confirm there are no image blocks,
   capture files, or capture attempts. Check roles, values, supported actions, snapshot identity,
   stale-token errors, and the readable Calculator display.
5. Perform a fixed AX button press with no coordinates or alternate delivery mode.
   Verify the displayed result through a new tree. Check the pinned route rather
   than assuming any tool named `click` is accessibility-only.
6. Probe denied app access, screenshot requests, pixel/foreground variants, unknown
   tools, stale tokens, locked-screen behavior, revoked permissions, stdin EOF,
   cancellation, and forced owner exit. There must be no surviving run-owned
   driver or continued input after teardown.

The owner grants Accessibility to the identity actually used by direct mode.
Do not assume an existing `CuaDriver.app` grant covers it. Leave Screen Recording
ungranted for the probe; verify AX reads and actions still work without a capture
request. If the runtime requires capture permission or generates images anyway,
the accessibility-only gate fails. Do not automate System Settings or OS prompts.

The probe must also establish how the loaded manifest/policy can be verified and
whether resource restrictions prevent broad metadata disclosure. Record both
successful and refused calls with content-free outcomes. A schema mismatch or
missing enforcement is a failed gate, not permission to expose the full driver.

### Stage 22b: Read-only Poppet trial

Only after 22a passes, extend `@poppet/computer-use` with the smallest
capability-owned adapter, following `@poppet/browser`'s package boundary. The
package already owns the isolated compatibility probe. The adapter will own driver
settings, the run-scoped client, the window binding, reference validation, and
normalized text results. The CLI adapts its errors and tools to `ExternalTools`.
Keep the normal MCP catalog separate; do not expose raw driver tools as a second
route around the adapter's fixed arguments.

Configuration is disabled by default. The proposed `computer` section needs only
`enabled` and an absolute installed `command`; Calculator and the permitted
operations remain fixed for this trial. Preserve file defaults and complete
`POPPET_COMPUTER` overrides, including explicit disablement, using the existing
configuration pattern. No credentials, arbitrary arguments, endpoints, policy
paths, or general app allowlist are needed in this first version.

Add an explicit, proposed `chat new --computer` opt-in for one standalone run.
This syntax does not exist yet. Forward a host-only permit through `Agent.send`
and `ExternalTools.snapshot`; absent permits deny access. Never infer it from
prompt text, saved history, a skill, or a model argument, and never persist it on
the session. Worker request schemas must not accept it. If a worker owns the
selected data directory, reject the trial with an actionable diagnostic; do not
bypass storage ownership or silently route it through the worker.

Use a separate trial data directory with empty notes/profile/memory, no channels
or scheduled work, and other MCP/browser/search capabilities disabled. Provider
authentication still follows the normal credential path. Existing arbitrary
owner-configured MCP servers are outside this computer feature's boundary and
must not be configured in the trial. Ordinary chats must not start the driver.

Expose `poppet_computer.snapshot` with no model arguments. The host supplies the
bound window, screenshot-free options, and limits. Return one normalized JSON
observation with `snapshotId`, app/window identity, bounded element references,
roles, labels, values, enabled state, supported actions, and `truncated`. Strip
unneeded geometry and metadata. No raw provider image or attachment is produced.
Use fresh complete observations rather than upstream diff merging in this trial.

First ask a real model to identify Calculator's display and available arithmetic
buttons. Inspect saved calls and the actual window; no action tool is offered in
this stage. This separates useful observation from action routing and verifies
that tool-capable text models can consume the result without image support.

### Stage 22c: Bounded AX button actions

After the observation check passes, add `poppet_computer.press` accepting only a
reference from the latest returned snapshot. The host maps it to a driver token
and fixes the window, left button, AX `press`, and background delivery. Never
accept model-selected PIDs, window IDs, sessions, coordinates, alternate actions,
modifiers, file paths, or launch settings. Check that the retained element is an
enabled pressable Calculator content button; exclude window chrome and menus.

Validate references both during batch preparation and immediately before dispatch.
Consume the current references when an action is dispatched, even when its result
is lost. A later run, replaced snapshot, changed window, or restarted app cannot
reuse them. Do not silently rebind to a replacement process/window or retarget by
label when a token is stale.

Return a fresh snapshot after each completed press, so the next decision uses
observed state without spending a separate model turn on another read. If action
delivery succeeded but observation failed, report that the effect is unverified;
do not turn that into a clean refusal or retry the press. Driver refusal before
dispatch, stale reference, unverified effect, and transport uncertainty must stay
distinct. A reported event delivery is not proof that the display changed.

Instruct the model to send one computer operation per turn. Preserve the agent's
whole-batch validation; do not claim a multi-call batch is atomic. If multiple
presses were prepared from one snapshot, dispatch-time validation must reject a
later consumed reference before sending it. No rollback or automatic replay is
attempted. Refreshing observation is allowed; repeating an action with an unknown
outcome requires the owner to inspect state and make a new request.

The run opt-in, explicit calculation request, and fixed Calculator boundary are
the trial's authorization flow. There is no per-click approval UI. Any request
outside that boundary fails closed. App text and driver descriptions/results are
untrusted data; they cannot enable another app or authorize note, memory, task,
page-fetch, or other external actions. Reuse the existing prompt and tool checks;
they are not an OS sandbox or proof against arbitrary prompt injection.

### Ownership, limits, and saved data

One scoped MCP connection and directly owned driver process belong to one Poppet
run. Use its implicit lifecycle session or a host-chosen identity, never a
model-selected session label. Hold an additional per-user desktop lease across
data directories, reusing `acquireOwnerLock` at a stable protected path. A second
Poppet computer trial must fail busy rather than contend for Calculator. This
cannot lock out the human or unrelated automation; the owner must set the app
aside and stop other desktop drivers for the attended check.

Create private runtime files with directory mode `0700` and file mode `0600`.
Pass a minimal child environment without provider/channel secrets or inherited
Cua overrides. Fix bounded mode, the generated manifest/policy, and no file or
desktop-capture grants before connecting. Manifest expiry and idle bounds must
cover at most the existing five-minute chat deadline, without automatic renewal.
Do not attach to an ambient socket or run a service at login.

Reuse existing budget settings. Initial proposed bounds are 128 AX elements,
depth 12, and a one-second tree walk; the compatibility probe must show Calculator
fits. Cap protocol messages and each process pipe at 256 KiB and model arguments
at 64 KiB. Keep each model-facing result within `POPPET_TOOL_BYTES`, preserve
Unicode/valid JSON, and mark both upstream and host truncation. Do not expose
action references from an incomplete observation. Bound startup and each MCP
request using the existing eight-second startup and ten-second request limits;
adjust only a measured computer-specific limit if the real probe requires it.

Keep the default eight model turns and sixteen tool calls. An initial snapshot,
clear, five arithmetic presses, and a final answer fit eight model turns when
each press returns its observation. Do not raise global budgets for this demo.
Record startup/observation/action/cleanup durations and call counts as evidence;
make no performance claim before measurement.

Completion, failed startup, timeout, Ctrl-C, permission loss, and consumer exit
must invalidate references, end the session where possible, close MCP, reap the
owned child, and remove private files before releasing the desktop lease. Bound
graceful shutdown and terminate only a verified owned child if needed. Report
cleanup failure and leave no path that silently resumes the abandoned workflow.
The app was opened by the owner and must remain open. Do not quit or reset it as
cleanup. OS permissions remain until the owner revokes them.

Reuse durable external-call records with `serverId: "computer"` and operation
names `snapshot`/`press`. Interrupted dispatched calls remain uncertain, including
after restart. Existing chat history stores normalized observations and arguments
under its normal retention rules; AX text is not ephemeral just because private
runtime files are removed. No screenshot, raw desktop dump, recording, or separate
history store is added. Use disposable trial content and keep raw driver output
out of diagnostics. Broader sensitive-app support needs a retention decision.

### Implementation reach and verification

The following is the expected scope after the probe, not a request to implement:

| Area                    | Required work                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/computer-use` | Fixed trial schemas/tools, driver ownership, window/reference checks, result normalization, fixture and explicit real-driver self-check       |
| `packages/mcp`          | Reuse existing SDK, schema/result helpers and scoped transport; narrow exports only where required, without changing ordinary MCP behavior    |
| `packages/config`       | Disabled settings, file/environment precedence, path validation, pure config inspection, decoding fixtures                                    |
| `apps/cli`              | Fresh standalone-chat opt-in, host composition, worker-routing rejection, diagnostics, package dependency and CLI/runtime fixtures            |
| `packages/agent`        | Host permit reaches the external snapshot with default denial; preserve validation, budgets, saved identities and uncertain outcomes          |
| Worker, gateway, tasks  | Prove omission of computer tools and rejection of forged permits; no new remote execution command                                             |
| Documentation           | Trial setup/limits/manual checks; update configuration, CLI, chat, architecture, development, worker/tasks references and this phase's status |

Automated tests use a fixture stdio driver and injected models, with no real
desktop, OS grants, external network, or inference account. Reuse existing
cross-provider text-tool tests instead of duplicating provider suites.

| Behavior                     | Evidence required                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Default denial               | No process without config plus the current local opt-in; no tools in ordinary, resumed, worker, messaging, scheduled, or title-generation runs |
| Window and resource boundary | Other apps, broad enumeration, process/window replacement, desktop scope, screenshots, files, and launch/session overrides cannot dispatch     |
| AX-only actions              | Only current enabled content-button refs; all coordinate, foreground, key, modifier and alternate-action forms fail before dispatch            |
| Snapshot lifetime            | Replaced, cross-run, truncated, and consumed refs fail; a second prepared press cannot reuse the first press's snapshot                        |
| Honest outcomes              | Failed post-action observation stays unverified; timeout/disconnect/cancellation stays uncertain; no replay after reconnect/restart            |
| Ownership                    | Separate data directories contend on the desktop lease; startup failure and every exit path close/reap the owned child and release state       |
| Bounded data                 | Malformed/oversized protocol output, partial trees, Unicode, result limits and accidental media fail safely without leaking raw diagnostics    |
| Untrusted text               | App/driver prompt injection grants no computer scope, built-in mutation, or page-fetch authority                                               |

Use `bun run test` for focused behavior checks and `bun run check` for the completed
implementation. The real-driver self-check is a separate, explicitly invoked
manual step; passing fixture tests does not prove TCC attribution, application
behavior, AX-only delivery, or real-process cleanup.

Manual completion path after implementation:

1. Record the pinned driver/OS/app versions and sanitized 22a probe results. Confirm
   the narrow manifest, direct runtime identity, Accessibility grant, and absence
   of Screen Recording permission and screenshots.
2. Use disposable Poppet state and the prepared Calculator window. Complete one
   real-model read-only observation through the CLI.
3. Explicitly request clear and `12 + 7`. Observe `19` in the actual app and saved
   snapshot; check that only allowed AX presses were dispatched and the answer
   reports the observed result.
4. Exercise a stale reference, another-app request, denied screenshot/input forms,
   permission loss, and a second simultaneous trial. They must refuse without
   changing the target or widening authority.
5. Cancel while observing and while a press is in flight. Repeat with timeout and
   owner-process exit. Inspect uncertain records, surviving processes, private
   files, the lease, and Calculator state. Never replay the uncertain press.
6. Run an ordinary chat and the existing automated suite to check that disabled
   computer support does not affect browser/MCP tools or normal routing.

### Completion gate and later Phase 22 work

The accessibility trial is complete only when protocol/permission gates, fixture
tests, read-only inference, bounded real-model action, saved-outcome inspection,
and real cleanup checks all pass. Mark results separately; a successful
Calculator demo does not establish reliable automation of other apps.

After the trial, decide whether a useful next workflow needs direct application
control at all; prefer an existing purpose-built MCP/API integration where it
already solves the task. Broader local app access needs owner-configured app
boundaries, explicit text-entry/action policy, sensitive-data retention, and an
approval/revocation design. Worker and messaging access need a separately defined
host-origin permit and desktop ownership model before any rollout. Scheduling
remains denied until unattended operation has its own validation.

Choose local desktop versus isolated computer again before enabling workflows
with real user data. Screenshot control is a later decision requiring
image-capable provider requests and model checks, bounded image storage/context,
retention, pixel grounding, and focus/input policy. No VM runtime, image pipeline,
generic mouse/keyboard tool, or general approval UI is part of the trial.

## Phase 23: Change-aware monitoring

Implemented with automated checks. Real-model monitoring and live messaging
completion remain manual. This phase adds an optional behavior to recurring tasks.
It depends on phases 7–11 for scheduling, recovery, and delivery, and phase 18 for creation
through chat. Page and MCP sources reuse phases 15 and 20. It can proceed
independently of computer use. Automated fixtures do not establish live
monitoring reliability; the manual completion path below remains outstanding.

Automated validation on 2026-10-21 passed `bun run check`: formatting, lint,
types, and 900 tests across 64 files, with zero failures. Integration checks used
isolated state and local socket access. No live provider or messaging validation
was performed.

### Goal and first version

Support requests such as "Check this release page every morning and tell me when
the latest stable version changes." Each successful check extracts one small,
stable value from fresh source data. The host compares that value with the last
successful observation and decides whether to publish a notification.

Reuse the existing task worker, fresh occurrence sessions, read-only tools,
SQLite owner, provider budgets and pauses, destination snapshots, and gateway
queue. Keep monitoring in `@poppet/tasks`; add no package, dependency, second
scheduler, or general event framework. Ordinary scheduled reports keep their
current behavior.

The first version monitors one scalar value per task, such as a release tag,
status, or explicitly ordered list encoded as text. The saved prompt must name
the source, the field to watch, and its stable representation. Compare the exact
validated value, never the final answer or a prose summary. The model extracts
the value; it does not choose whether an alert should be sent.

| Check result                                                     | Saved behavior                                                               | Notification                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------- |
| First successful observation                                     | Establish the baseline                                                       | None                             |
| Same value as the previous successful check                      | Record an unchanged check                                                    | None                             |
| Different value                                                  | Record the transition and advance the baseline                               | One saved change notification    |
| Fetch, extraction, validation, provider, or cancellation failure | Preserve the last successful baseline and record the unsuccessful occurrence | No change notification           |
| First success after failures                                     | Compare with the last successful value                                       | Notify only if the value differs |

Compare consecutive observations. An observed `A → B → A` produces two alerts;
repeated `B` observations produce none. Changes that happen entirely between
checks cannot be recovered. A monitor that has never succeeded is uninitialized,
not unchanged or healthy.

### Creation and inspection

`--monitor` on `tasks add` is valid only with `--cron` plus an explicit timezone.
Reject `--at --monitor` at both CLI and host validation boundaries. Reuse the
existing skill and destination flags. For example:

```fish
bun run start tasks add release-watch --monitor --cron "0 9 * * *" --tz Europe/London "Read https://example.com/releases.txt and report the latest stable release tag exactly as published. Ignore prereleases and publication timestamps."
```

This example keeps results local. Adding an existing messaging destination flag
selects normal authorized delivery. Creation returns the task ID, monitoring
mode, saved schedule, destination, and the fact that the first
successful check establishes a quiet baseline. It does not perform a check or
claim that the source works.

Use an explicit `add-monitor` action on the existing `/tasks` command endpoint,
with the same creation fields as `add`. An older worker must reject the unknown
action rather than silently create a reporting task and send every result. Do
not fall back to `add` after a rejection or ambiguous response. Share the actual
creation workflow, destination validation, deadline, and repository operations.

Extend `poppet_tasks.manage_tasks` with `create_monitor`, reusing the existing
creation arguments and atomic task/receipt transaction. Preserve ordinary
`create`. Monitoring creation needs the owner's current explicit request and a
clear watched value, source, schedule, and destination. Ask about missing details
rather than guessing whether every page edit matters. `here` retains its existing
meaning. Saved content and tool results cannot create monitors.

Existing list/show/pause/resume commands and chat actions also handle monitors.
Expose the mode in receipts and listings. In `tasks show`, include the last
successful value and observation time, latest check status and failure reason,
per-occurrence decision, previous/current values for changes, evidence references,
and notification delivery state. Include occurrence-level monitoring failures in
worker status even when the underlying model run completed successfully. Keep
chat inspection bounded under the existing tool-result budget.

Pausing keeps the baseline and cancels pending checks using current semantics.
Resuming compares the next successful check with that baseline and skips missed
recurring times. Pausing does not cancel an active check or retract queued alerts;
use the existing occurrence cancellation command for active work. Provider
selection and skill snapshots remain fixed as for ordinary tasks. No editing,
baseline-reset, snooze, or run-now commands are added in this phase.

### Observation contract and tool permissions

Add a task-owned `poppet_monitor.report_observation` tool through the existing
`ExternalTools` contract. Offer it only when the host resolves the current
session/run to a running monitoring occurrence in the owned database. Check that
binding again before accepting a submission. The scheduler already links the
run on its `started` event before the tool catalog is assembled; preserve and
test that ordering.

Compose this tool alongside allowed scheduled MCP reads in
`apps/cli/src/mcp.ts` and `runtime.ts`. Its host-owned instructions explain stable
values, fresh evidence, and quiet baseline behavior. Ordinary chats, ordinary
scheduled reports, naming requests, and resumed occurrence sessions receive no
observation tool. The model cannot supply a task ID, occurrence ID, destination,
previous value, notification decision, or permission flag.

A successful submission contains:

- `value`: a nonempty, trimmed string of at most 1024 UTF-8 bytes. Comparison is
  exact and case-sensitive, with no implicit case folding, numeric conversion,
  JSON canonicalization, or fuzzy matching.
- `summary`: a nonempty, trimmed explanation of the current observation, at most
  2048 UTF-8 bytes. It is display text and never participates in comparison.
- `sourceCallIds`: one to four distinct IDs of completed source reads earlier in
  the same run. Validate IDs against the durable tool journal, not model claims.

The serialized submission must also fit `POPPET_TOOL_BYTES`. Reject oversized
values instead of truncating the comparison input. Use strict schemas, existing
whole-batch preflight, durable tool identities, tool/model-turn limits, context
budgets, and run deadlines. Require exactly one completed observation submission
per successful monitoring check; duplicate, missing, or invalid submissions make
the check fail. Do not parse JSON out of the model's final prose or make another
model request to judge whether the text changed.

Accept evidence from `read_note`, `fetch_page`, or an explicitly allowed scheduled
MCP read. History recall and search snippets alone are not fresh source evidence.
A source call must precede the submission, belong to the current run, and have a
successful recorded result. Reject failed, uncertain, empty, or explicitly
truncated/omitted evidence in this first version. Inspect the existing result
envelopes, including MCP omission flags, rather than counting a transport reply
as sufficient evidence. Small source documents or focused endpoints are the
intended starting point. Do not interpret a missing field or unreadable source
as a legitimate empty value. A sentinel such as `none` is valid only when the
saved prompt defines it and the source establishes that state.

The journal proves which tools returned data, not that the model extracted the
right fact or that a remote service returned current information. Keep this
limitation explicit. Model variability can still cause false alerts or missed
changes; a precise source and stable field reduce that risk. The first version
does not provide arbitrary semantic judgments such as "tell me anything important".

Submission only records a candidate in the existing tool journal. Its receipt
must say that acceptance is pending successful check finalization. It does not
advance the baseline, enqueue delivery, or change external state. A later failed,
interrupted, or cancelled run discards the candidate for comparison purposes.
Persist the candidate through the normal call/result recording, not a separate
in-memory callback that would be lost on restart.

Scheduled tools retain their existing permissions. Notes, memory, and task
mutations stay blocked; browser and computer tools stay absent. MCP reads still
require `scheduledTools` approval. Source URLs retain the current supplied-URL
and completed-search grants and public-address checks. An evidence reference or
previous observation grants no new URL access. Treat source data, summaries,
and saved observations as untrusted data throughout.

### Storage, finalization, and crash recovery

Append the next timestamped migration and registration using the current
version-1 schema as the starting point. Do not rewrite the applied initial
migration or require a database reset. Add:

- A persisted monitoring flag on `jobs`, defaulting to false for all existing
  tasks. Validate recurring-only monitoring when creating tasks.
- One `job_monitor_results` table with a monotonically increasing integer key,
  a unique occurrence ID, job ID, observed value, summary, evidence references,
  observation time, previous value, decision `baseline` / `unchanged` / `changed`,
  and nullable saved notification text. Add foreign keys, bounds/checks, and an
  index for the latest result per job. Use commit order to find the previous
  successful observation; timestamps can tie or move backward.

The latest committed result is the baseline, so no second mutable baseline table
or hash is needed. Existing occurrence state represents unsuccessful checks.
Keep raw source bodies in the existing journal only. Define cascading deletion
or explicit deletion order so `tasks clear` removes monitoring state while
retaining saved sessions and already queued gateway replies as it does today.

Before finalizing a successful monitoring occurrence, validate that its linked
run completed and has exactly one eligible recorded candidate. In one immediate
SQLite transaction, verify the occurrence is still running, compare with the
latest result for that job, insert its unique decision and saved notification,
and mark the occurrence completed. Cancellation wins if it committed first.
Only a completed, validated monitoring occurrence can advance the baseline.
A repeated finalization returns the saved decision without comparing again.

Use a bounded host-rendered notification containing the task name, previous and
current values, observation time, summary, and source references resolved from
the journal. Store this text with the decision before it can become deliverable.
Keep the notification within 16 KiB and the normal channel chunking rules;
comparison values must remain intact. The model's final answer stays available
in `chat show` but is not the monitoring notification payload.

Extend both normal `finish` and repository `recover` paths. Today recovery marks
a running occurrence completed when its linked run completed. Monitoring must
instead run the same idempotent validation/comparison transaction. If the run
completed but the candidate is missing or invalid, mark the occurrence failed
with a monitoring reason, leaving the baseline intact. This can legitimately
leave a completed model run attached to a failed monitoring occurrence. A crash
before model completion leaves interrupted work and never advances the baseline.
Storage failure must roll back the decision and completion together and stop the
owner using the existing failure behavior.

Explicit retries reuse current task rules, create a fresh run/session, and
compare a new successful observation with the last committed result. Old failed
run candidates are never reused. Recovery may project a completed saved run;
it must never repeat inference or source reads to reconstruct a decision.

### Notification gating and failure behavior

Change `packages/gateway/src/repository.ts` so scheduled delivery selects ordinary
completed reports as before, and monitoring occurrences only when they have a
committed `changed` decision and saved notification text. Baseline and unchanged
checks must be filtered in SQL before the existing 64-row delivery limit, so
quiet checks cannot starve real alerts. A monitor with no committed decision
must never fall back to sending its model answer.

Update `scheduleResults` in `packages/gateway/src/service.ts` to use saved monitor
notification text while retaining ordinary report output. Continue using the
unique occurrence enqueue identity, existing chunk order, account/owner/channel
rechecks, bounded delivery retries, and uncertain-send handling. No channel
adapter or new outbound transport is needed.

Advancing the observation baseline does not mean delivery succeeded. If enqueue
has not happened, a restart finds the saved changed result and queues it. If
sending fails, the existing durable delivery remains inspectable and retries only
where already allowed. Repeated unchanged checks do not create replacement
alerts or roll back the baseline. Uncertain sends remain uncertain without
automatic reposting. Promise one queued notification per observed transition,
not exactly-once remote receipt.

An unchanged check is a successful completed occurrence with an explicit
`unchanged` decision, not an empty answer, failure, or skipped interval. Failed
checks preserve the baseline, appear in task inspection/status, and use normal
failure logs. Provider quota pauses and temporary backoff remain unchanged.
Recurring source failures do not stop future scheduled checks or trigger automatic
retries of the failed occurrence.

This version sends no automatic failure or recovery messages. It also adds no
quiet hours, cooldowns, cross-task deduplication, threshold language, multi-field
rules, webhooks, browser login state, or automatic corrective actions. Operators
must inspect failures and the last successful observation time; silence alone
does not prove that a monitor is working. Every scheduled check still uses normal
provider quota even when no notification is sent.

### Implementation order and reach

Keep the work in focused, independently reviewable steps:

| Step                            | Files and responsibilities                                                                                                             | Completion evidence                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1. Durable decisions            | New store migration and registration/tests; task schemas, repository finalization/recovery/clear, and exports                          | Existing tasks migrate unchanged; baseline/comparison/recovery work against temporary SQLite databases                       |
| 2. Observation capture          | Task-owned observation module and instructions; host composition in `apps/cli/src/mcp.ts` and `runtime.ts`; scheduler integration      | Injected-model checks extract a value from fresh evidence and save one validated decision with existing read-only boundaries |
| 3. Delivery                     | Gateway repository eligibility and service payload selection; existing gateway tests                                                   | Quiet checks never enqueue; changes enqueue once and survive restart without new inference                                   |
| 4. User commands                | CLI task flag/parser, explicit worker action, task commands/socket decoding, chat tool/action decoding and receipts, status/inspection | CLI and authorized chat create and inspect the same monitor; an old worker rejects creation safely                           |
| 5. Documentation and live check | Tasks, CLI, chat, storage, architecture, development, documentation index, and this phase's status                                     | Document proposed commands as implemented only after code lands; complete the manual path below                              |

Update affected task factories, injected model responses, strict tool schemas,
command fixtures, repository decoders, host layers, and public exports alongside
each step. Keep the provider message format and adapters unchanged. Reuse existing
channel and text-tool coverage rather than adding another suite per provider or
messaging adapter. No global monitoring configuration is required.

### Verification and completion gate

Use the existing isolated test runner, injected models, temporary SQLite stores,
controlled page/MCP/note fixtures, and a controllable clock. Cover these distinct
behaviors:

1. Quiet first observation, same-value suppression despite different summaries,
   one alert on change, and both transitions in `A → B → A`.
2. Missing, duplicate, malformed, oversized, stale, foreign-run, or incomplete
   evidence fails the check. A successful read followed by model failure or
   cancellation never commits its candidate. A valid value differing only in
   case is a change under the documented exact comparison.
3. Crash after run completion but before decision commit, after decision commit
   but before enqueue, and after enqueue. Recovery preserves the original
   decision, creates no duplicate queue entry, and makes no new provider call.
4. Cancellation versus finalization, retry with fresh evidence, pause/resume,
   baseline persistence after restart, and failure between successful checks.
   Quota pauses and missed/DST schedule behavior reuse existing scheduler tests.
5. Ordinary reports still deliver. More than 64 quiet monitor results cannot
   block a changed result. Failed/uncertain delivery does not undo the baseline
   or cause another alert on the next unchanged check.
6. Observation tools are absent outside active monitor runs. Forged IDs, source
   prompt injection, and old candidates grant no tool, mutation, destination,
   or page-fetch authority. Read-only scheduling and existing access rechecks
   remain effective.
7. Local and worker-backed creation, authorized chat creation/receipts, recurring
   validation, old-worker rejection, bounded inspection, version-1 migration
   with existing tasks/results, and task clearing with queued replies retained.

Run focused `bun run test <path>` commands as each step lands, then
`bun run check` for the completed implementation. Keep real inference, external
sites, and messaging accounts out of automated fixtures.

For manual completion, use disposable state and a small controlled source with
an editable release tag. Create one real-model monitor with an authorized
messaging destination. Observe a quiet baseline, a quiet unchanged check, then
one delivered alert after changing the tag. Restart the worker and confirm that
another unchanged check stays quiet. Make the source unavailable, inspect the
failed check and preserved baseline, restore it, and verify comparison resumes
against the last successful value. Inspect saved decisions, evidence, and queue
states throughout. Record provider and channel evidence separately from tests.

The phase is complete when the automated checks and this real-model delivery
path pass. Until then, mark implementation, fixture coverage, and live validation
separately. Model extraction accuracy, incomplete source visibility, polling gaps,
and uncertain remote delivery remain explicit limits after completion.

## Phase 24: Editable tasks and snoozing

Implemented through Stages 24a–24d with automated checks. This phase extends
the existing task commands, worker endpoint, and `poppet_tasks.manage_tasks`
tool, building on phases 7–9, 18, and 23. The stages below describe the delivered
contracts. Live model intent handling, physical sleep/wake, and live messaging
validation remain manual; the automated paths use isolated stores and injected
models rather than the owner's running worker or accounts.

### Goals and boundaries

Support changing a saved task's name, prompt, or schedule while retaining its ID,
history, provider selection, skill snapshot, and delivery destination. Then add
controls for one upcoming execution. Reuse the single task worker, SQLite owner,
cron/timezone handling, command lock, tool receipts, and gateway delivery queue.
No new dependency, scheduler, general workflow engine, or global configuration
is needed.

| Operation | Meaning                                                             | Recurring schedule                                             |
| --------- | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| Edit      | Change the task definition for work that has not started            | Replace only when explicitly supplied                          |
| Skip-next | Cancel exactly one selected upcoming execution                      | Keep the regular cadence                                       |
| Snooze    | Delay exactly one selected upcoming execution until a later instant | Keep the regular cadence; do not accumulate intervening checks |
| Run-now   | Queue an explicitly requested execution through the normal worker   | Keep the regular cadence                                       |

Snooze delays execution, not an already queued gateway message. Reposting a
previous alert, acknowledgement reminders, duration-expression parsing, editing
provider/model/workload/skills/destinations, changing reporting versus monitoring
mode, and bulk edits are outside this phase. Keep those separate from the core
controls. Natural-language chat may resolve an explicit relative time using the
current request time; the tool still receives a concrete timestamp.

### Shared mutation and history rules

Use stable task IDs. Every definition edit carries the revision returned by
inspection. The CLI can read that revision automatically before issuing the
mutation; chat must inspect before editing. Revalidate it inside the committing
transaction. Reject a stale revision instead of silently refreshing and applying
the same request to a newer definition.

Reject edits and the new timing controls while that task has a running
occurrence. Do not interrupt it implicitly or wait for the shared agent to become
idle. The owner may use the existing explicit cancellation command first.
Recheck running state when committing, under the same command ownership used
for claiming work. This also covers a completed model run whose occurrence has
not yet finalized. Other tasks may continue running normally.

Edits are allowed on paused tasks and never resume them. Skip-next, snooze, and
run-now require an unpaused task. They never clear a provider pause or grant
additional tools. Ordinary scheduled work and monitoring retain their read-only
execution policy.

Persist a small task-change record in the same transaction as each mutation.
Record the operation identity, task/revision, time, changed fields or selected
occurrence, and resulting schedule/timing state. Definition edits retain before
and after values for the edited fields. Keep this task-specific; do not introduce
a general event-sourcing layer. Bound stored fields using existing task limits.

Chat mutations and their durable tool receipts must commit together, as creation
does today. Derive chat operation identity from the host's run/call IDs. CLI
mutations carry a client-generated request ID; repeating the same request ID
returns its original saved receipt. A timeout or lost response must not trigger
local fallback, a new request ID, or a second mutation. A user issuing a separate
command after an ambiguous result should inspect the saved task/change first.

New actions use explicit discriminators on `/tasks`, so an older worker rejects
them instead of ignoring extra fields or turning them into ordinary creation.
Keep the bounded command deadline and validate future times again at commit,
including time spent waiting for command ownership. A failed receipt/history
write rolls back the mutation. Log committed IDs, actions, and times without
printing prompts, note contents, credentials, or model output.

### Stage 24a: Edit a task definition

Implemented CLI interface:

```fish
bun run start tasks edit <task-id> --name "Morning review"
bun run start tasks edit <task-id> --prompt "Read project.md and summarize its open decisions."
bun run start tasks edit <task-id> --cron "30 8 * * 1-5" --tz Europe/London
bun run start tasks edit <task-id> --at 2099-10-22T09:00:00+01:00
```

Allow a nonempty patch containing name, prompt, and/or a complete schedule.
Omitted fields stay unchanged. Reuse existing name/prompt byte limits and the
existing once/cron parsers. A recurring replacement needs both expression and
explicit timezone; a one-off replacement needs a future offset-qualified
instant. Reject conflicting schedule forms, timezone-only patches, unknown
fields, and empty patches. Identical supplied values are a no-op and do not
cancel work, increment the revision, reset monitoring, or add another change.

Report tasks may switch between once and cron schedules. Monitors must remain
recurring. Changing a completed one-off's name or prompt does not execute it
again; supplying a new future schedule explicitly rearms it. Schedule edits
replace any snooze override introduced in Stage 24c, and the receipt must say so.

When a schedule changes, cancel any pending occurrence with a specific
`task-edited` reason and compute the new next time from the commit time. Do not
backfill old recurring slots. Preserve the paused flag, completed/failed history,
old session names, and already queued messages.

For a name/prompt edit with a pending occurrence, replace that unstarted
occurrence in the same transaction using the new definition revision. Preserve
its logical schedule time, effective ready time, and destination snapshot.
Record the replaced occurrence as cancelled, retaining its original definition
for inspection. If no pending occurrence exists, preserve the current `nextAt`.
A pending one-off can therefore receive its edited prompt without disappearing
or creating two executions.

Extend `manage_tasks` with `edit`. Reuse its nullable name/prompt/schedule fields
as the patch, add an inspected revision, and keep unrelated fields null. Validate
at least one editable field. The model cannot supply a provider, owner,
destination, permission, or skill override. Mutate only on the current owner's
explicit request, never from history, pages, notes, skills, or tool output.

The receipt includes task ID, old/new revision, effective changed fields, next
time, paused state, replaced occurrence IDs, and whether a monitoring baseline
was reset. Inspection shows current definition and historical occurrence
snapshots; renaming a task does not rename existing chat sessions or threads.

### Definition snapshots and monitoring baselines

Queued occurrences currently retain a destination but read the current task
when claimed. Add a persisted execution-definition snapshot and definition
revision to each occurrence. Save only the fields needed to execute and inspect
it: name, prompt, provider, model, workload, skill snapshot, monitoring mode, and
schedule. Keep the existing per-occurrence destination authoritative. Claiming
and explicit retries use the occurrence snapshot, not the current mutable job.
Expiration and retry eligibility use that snapshot's scheduling kind as well;
an edit must not retroactively change the policy for historical work.

Change occurrence uniqueness from task/time to task/definition-revision/time.
Keep the existing constraint permitting at most one pending or running
occurrence per task. This lets an edit replace an unstarted slot or move a
schedule back to a previously cancelled future time without deleting history or
colliding with its old occurrence. Automatic reconciliation must still avoid
duplicate slots within one revision.

Add a monotonically increasing definition revision on jobs. An edit increments
it only when at least one supplied field changes. Append the next migration
from the current version-2 schema and backfill existing occurrences at revision
zero using their current task definition and their own saved destination. Before
this feature, definitions were immutable through supported commands, so this is
the available definition for legacy rows. Do not claim to reconstruct unsupported
manual database edits.

Rebuilding occurrence uniqueness must preserve related monitoring results and
all original IDs. Plan the parent/child table copy and rename together; dropping
an occurrence table with cascading foreign keys can delete monitoring history.
Keep migration atomic and preserve result ordering, constraints, indexes,
sessions, tool calls, and gateway records. Never rewrite applied migrations or
require a database reset. Add fields for later timing stages only when those
stages are implemented.

A monitor name or schedule edit preserves its successful comparison baseline.
Any actual prompt change conservatively starts a new quiet baseline, because
the host cannot decide whether the watched field or source changed semantically.
Retain old results for history. Store a per-job baseline boundary using the last
committed monitor-result ID, and compare only results after that boundary.
Do not delete observations or clear unrelated facts.

Recheck that no occurrence is running before moving that boundary. Keep normal
finalization and restart recovery consistent with occurrence snapshots and the
current baseline boundary. Explicit retry of an old monitor occurrence predating
the latest prompt change must be rejected; instruct the owner to use the next
current-definition check. A name/schedule change alone does not make prior
monitor evidence belong to a different watched value.

### Stage 24b: Skip exactly one upcoming execution

Add `tasks skip-next <task-id>` and the matching chat action. Select the pending
occurrence if one exists; otherwise select the next scheduled slot. Bind the
request to the inspected occurrence ID, or to the inspected next-slot timestamp
plus definition revision. For pending targets, also bind the inspected effective
ready time and pending state. Revalidate the target at commit. Do not silently
select another slot if the scheduler or another command moved it meanwhile.

Cancel the selected pending occurrence with an explicit skip reason. If the
selected slot has not been queued, persist a cancelled occurrence for that slot
with its definition/destination snapshot. Advance `nextAt` exactly once from the
selected logical slot when necessary, not from when the command happened to
arrive. Reuse the existing reconciliation policy for any further overdue slots;
do not accidentally enqueue a backlog.

For a one-off task, skipping consumes its only scheduled execution. It remains
inspectable and may be explicitly retried under existing rules. For recurring
work, the next regular slot remains scheduled. No task definition edit or monitor
baseline reset occurs. The receipt identifies the exact skipped slot and the
next time. Replayed operation IDs cannot skip a second slot.

### Stage 24c: Snooze the next execution

Implemented interface:

```fish
bun run start tasks snooze <task-id> --until 2099-10-22T10:00:00+01:00
```

Add `snooze` to the chat tool with an absolute offset-qualified `until` value.
Ask about ambiguous targets or local times. Use the same explicit target binding
as skip-next. Require a scheduled or pending execution; do not recreate completed
one-offs or snooze an already sent result.

Persist `availableAt` separately from immutable logical `scheduledAt`. Initially
it equals `scheduledAt`. Snoozing moves only `availableAt` to an instant later
than both now and the target's current effective due time. An identical future
until value is a no-op; moving earlier is not snoozing in this version. The
receipt shows the logical slot, new ready time, and unchanged recurring schedule.

If the next slot is not queued yet, materialize that one pending occurrence with
its snapshot and requested ready time, advancing the stored next slot once.
This must not make it runnable early: claiming now needs `availableAt <= now`,
with deterministic ordering by ready time, logical time, and ID. Keep the
single-pending/running-per-task rule. While a recurring check is held, intervening
cron slots follow existing busy-skip behavior instead of accumulating more work.

Use effective ready time for recurring pending expiration and explicit-retry
freshness checks, preserving the existing 24-hour window after that time.
Otherwise a deliberate long snooze could expire before its requested execution.
One-off work keeps its existing no-expiration policy. A stopped worker later
runs the persisted pending occurrence once when eligible, subject to expiration
and provider pauses; do not rebuild it from an in-memory timer.

Pausing cancels pending work, including a snoozed occurrence, while preserving
monitoring history. Resuming a recurring task resumes its ordinary cadence and
does not restore the cancelled snooze. A cancelled one-off still needs an explicit
retry or future schedule edit. Clearing tasks removes timing overrides with task
history and retains existing queued gateway messages.

### Stage 24d: Run-now as a separate follow-up

Add `tasks run-now <task-id>` and the matching chat action only after the earlier
stages have passed. Queue through the same worker, fresh session, snapshot,
read-only policy, provider pauses, budgets, and delivery path. The command receipt
acknowledges queued work, not an answer or successful delivery.

If a regular occurrence is already pending and eligible, return that same
occurrence rather than queueing another. Reject a future snoozed/held occurrence
or running task instead of silently undoing a snooze or bypassing active work.
If a regular slot is already due but not queued, consume that slot through normal
reconciliation. Otherwise, a recurring task gets one explicitly marked manual
occurrence at now, without moving its next regular time. An unstarted one-off
runs its selected logical slot early and consumes its future schedule. Its
ready time may therefore precede its logical schedule time; only the explicit
run-now action can introduce that early eligibility.

Persist manual origin so inspection and expiration policy are explicit. A manual
extra run keeps the normal recurring freshness window; one-off work keeps its
no-expiration policy. A historical occurrence-key collision must fail clearly,
never return an unrelated completed answer or manufacture a different timestamp.
Operation-ID replay returns the original queued receipt. For a monitor, run-now
is another check using the same baseline rules; it does not force a notification.

### Implementation reach and delivery order

| Stage          | Required work                                                                                                                                                                                                                                                     | Acceptance focus                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 24a. Editing   | Task schemas/repository/commands and exports; migration/fixtures; occurrence snapshots, uniqueness, retry and recovery; monitoring baseline boundary; CLI parser and `command-args.ts`; worker actions/deadlines; chat arguments, receipts and bounded inspection | Edit without changing task identity, rewriting history, executing old pending definitions, or comparing different monitor prompts |
| 24b. Skip-next | Exact target resolution, cancelled-slot persistence, schedule advancement, operation identity and receipts; CLI/chat exposure                                                                                                                                     | Skip the selected execution once without shifting recurring cadence or selecting a different target after a race                  |
| 24c. Snoozing  | Persisted ready time; reconciliation, claim ordering, expiration, retry, pause/resume and inspection; CLI/chat exposure                                                                                                                                           | No early execution, survives restart, one held occurrence, and no backlog after the delay                                         |
| 24d. Run-now   | Durable manual origin and enqueue operation, existing-pending reuse, one-off consumption, receipts and CLI/chat exposure                                                                                                                                          | One queued run through ordinary permissions and provider holds, with recurring cadence preserved                                  |

Keep each stage independently reviewable with its behavior tests and documentation.
Extend existing task/socket/scheduler, agent task-tool, CLI/host, store migration,
and gateway regression fixtures. Reuse providers and channel adapters unchanged.
Update tasks, CLI, chat, storage, architecture, development, and this plan as each
stage lands; examples here are proposed interfaces until implementation exists.

### Verification and completion gates

Use `bun run test <path>` with temporary SQLite state, injected models, and a
controllable clock. Run `bun run check` after each delivered stage. Do not add
wall-clock sleeps, live model accounts, or messaging services to fixtures.

Prove these distinct behaviors:

1. Partial edits and no-ops; complete timezone-aware schedule replacement;
   one-off rearming; invalid/past timestamps, unknown fields, and monitor-to-once
   rejection. Clock checks happen at commit, including after queue delays.
2. Replacement of a pending one-off/cron occurrence with the new revision;
   cancellation history and old snapshots retained; task ID, selections,
   destination, completed sessions, queued replies, and paused state preserved.
3. Claim/edit races, stale revisions, running-task rejection, receipt/history
   rollback, repeated operation IDs, lost responses without local fallback, and
   old-worker rejection. No mutation waits for the agent or deadlocks its run.
4. Migration from version 2 with pending, completed, and monitored work;
   parent/child foreign-key preservation, occurrence-key replacement, backfill,
   failed-migration rollback, and task clearing without losing queued replies.
5. Prompt-edited monitors establish a fresh quiet baseline while rename/schedule
   edits preserve comparison. Old observations remain inspectable; stale monitor
   retries cannot contaminate a new baseline. Recovery reaches the same result.
6. Skip a queued or not-yet-queued slot, skip a one-off, and repeat an acknowledged
   skip. A changed inspected target fails instead of skipping the following slot.
7. Snooze before/after queueing; no execution before ready time; long snooze and
   expiration after ready time; timezone/DST boundaries, missed cron slots, worker
   restart, provider pauses, repeated snooze, pause/resume, and cancellation.
8. Run-now with future/due/pending/held/running work; manual duplicate protection;
   one-off consumption; unchanged recurring cadence; monitor checks that stay
   quiet when unchanged; ordinary delivery authorization and uncertain sends.
9. Strict model argument schemas, bounded history/receipts, and explicit-current-
   request authority. Recalled or fetched text cannot edit a task, snooze work,
   create manual runs, choose destinations, or expand scheduled tool access.

After each stage, use disposable local state for a short CLI and worker-backed
manual path. Edit a saved task and inspect its identity/history; skip one slot;
snooze one check, restart before it is due, and verify it runs once afterward.
For monitoring, edit the source prompt and confirm a new quiet baseline. When
Stage 24d exists, request run-now and confirm the next cron time stays intact.
Separately exercise the implemented chat actions with a real model and one
authorized messaging destination, checking receipts and eventual delivery.

Passing fixtures or planning this phase does not establish real-model intent
handling, physical sleep/wake behavior, or live messaging reliability. Record
implemented stages, automated validation, and manual evidence separately.

## Phase 25: Documents and voice messages

Implemented for one attachment in the configured owner's private Telegram chat.
Local transcription was explicitly selected by the owner and stays opt-in. This
phase builds on the durable gateway inbox and text-only agent from phases 4, 10,
and 12, with text files, PDF extraction and voice transcription sharing intake. Other adapters can adopt the shared contract later.

### Goal and first version

Let the owner send a short document with a question and receive an answer grounded
in its extracted text. Accept UTF-8 `.txt`, `.md`, and `.markdown` files first,
then text-based PDFs. A document without a caption gets a short summary; a caption
supplies the current request. An unsupported or unreadable attachment receives a
clear reply without starting inference on an empty substitute.

Keep provider messages text-only. Reuse the existing agent context budget,
conversation storage, cancellation, and answer delivery. Do not add native model
file uploads, images, OCR, archives, remote-link ingestion, generated attachments,
or a document search index. The compatibility probe selected a local speech
runtime; existing provider credentials are not used for transcription.

The implemented initial limits, checked during the compatibility probes:

| Input          | Download limit | Processing limit                                         | Text supplied to the agent       |
| -------------- | -------------- | -------------------------------------------------------- | -------------------------------- |
| Text document  | 64 KiB         | Strict UTF-8, one file                                   | At most 32 KiB                   |
| Text-based PDF | 8 MiB          | At most 64 pages and 30 seconds                          | At most 32 KiB, with page labels |
| Voice message  | 8 MiB          | At most 2 minutes and a 90-second transcription deadline | At most 16 KiB                   |

These are host limits, independent of platform or service limits. Smaller remote
limits still apply. Count bytes while streaming, even when metadata or
`Content-Length` claims a smaller size. Reject oversized text files rather than
silently cutting off instructions. PDF extraction may return a bounded excerpt
only when the receipt and model input both state which pages/text were omitted.
Combined captions, extracted text, instructions, and tools still have to fit the
existing context budget; do not raise it automatically.

### Stage 25a: Authorized intake and text files

Extend the adapter-normalized message with optional, bounded attachment metadata.
Preserve decoding of existing text-only inbox records and leave other adapters
unchanged. Retain the original caption separately from extracted content; gateway
controls such as `/cancel` and `/new` must parse only the owner's message text,
never text found inside an attachment.

Telegram normalization must check owner ID, private chat, bot/account identity,
and supported message shape before downloading anything. Use an opaque platform
file reference tied to that message. Resolve it through the configured adapter,
not through a model-supplied URL or local path. Validate file type using metadata
and actual bytes; filenames and declared MIME types alone are insufficient.
Use generated local filenames, reject redirects outside the intended service,
and keep token-bearing download URLs out of storage, errors, and logs.

Continue saving the normalized inbox entry before advancing the polling cursor.
Deduplicate using the existing account/message identity. Add an attachment result
record keyed to that inbox entry, holding safe metadata, processing state, content
hash, extraction version, and the accepted text or a bounded failure reason.
Save the accepted text before starting the model run. Duplicate updates and
restarts must reuse that result and the inbox's existing run binding, rather than
start another chat or deliver another answer.

The worker owns download and extraction. Do not run them inside an open database
transaction or occupy the model permit while downloading. Use a scoped private
temporary directory, bounded reads, cancellation, and cleanup on success, failure,
and shutdown. On restart, remove only abandoned temporary directories owned by
this feature. An interrupted local download/extraction may restart from the
platform reference within a bounded retry policy. An expired reference receives
an actionable failure; there is no alternate arbitrary-URL fetch.

Pass extracted document text as clearly labelled untrusted source material with
its filename and completeness information. It cannot authorize note/memory/task
mutations, tool installation, URL fetching, or a new destination. A caption may
authorize an action under the existing current-request rules; instructions inside
the file cannot. Keep the same distinction in saved history and recall, not just
in the first prompt. Automatic titles use the caption or a safe attachment label.

### Stage 25b: Text-based PDF extraction

First run a local compatibility probe against a small, maintained parser supported
by the pinned Bun runtime. Reuse an installed suitable library if available;
otherwise select and pin one dependency after verifying text extraction, Unicode,
page boundaries, cancellation, and memory use on bounded fixtures. Do not depend
on a shell command merely because it happens to be installed on the developer's
machine. Keep this probe separate from live inference.

Run parsing in an owned worker or subprocess that can be terminated at its
deadline; a synchronous parser must not block the gateway or defeat cancellation.
Disable external resource loading, embedded scripts, attachments, and network
access in the parser where applicable. Reject encrypted/password-protected PDFs,
malformed files, image-only documents, and inputs that exceed processing limits.
Do not silently send them to an OCR service.

Retain page numbers in the extracted text so answers can cite the document and
page. Describe extraction as text extraction, without claiming that diagrams,
layout, tables, or every page were understood. A partial result must never be
presented as a complete document. Reuse Stage 25a's intake, durable result,
retention, and delivery path rather than adding another upload system.

### Stage 25c: Opt-in voice transcription

The owner selected local transcription. The implemented route uses configured
FFmpeg and whisper.cpp executables with a local model, validated against a
disposable Ogg/Opus sample. The [compatibility record](attachment-probe.md) gives
pinned tested versions, formats, installation requirements, and latency/resource
measurements. A cloud-service comparison was superseded by that explicit choice.
No subscription auth or general provider interface is used for transcription.

Voice processing is disabled until the owner configures that route and is told
where audio goes. Reuse authorized attachment intake, validate actual audio format
and duration, and bind the transcript to the original owner/message identity.
Store the accepted transcript before inference. Local subprocesses are terminated
on cancellation or deadline. No audio service, remote billing or automatic model
download is involved.

For the first version, show the transcript before any consequential mutation.
Ordinary questions can receive a transcript and answer together. A dictated
reminder produces a proposed task with its resolved time/timezone and asks for
owner confirmation in a subsequent message before calling the existing task
tool. Do not treat model-inferred words, background speakers, or embedded audio
instructions as separately authenticated requests. Ambiguous transcription gets
a clarification, not an invented task or fact.

### Retention, implementation reach, and completion gates

Remove raw document/audio bytes when processing finishes. Keep only the bounded
accepted text and safe source metadata alongside the durable conversation.
Explain that removing temporary audio does not remove saved transcripts, answers,
or provider-side records. Reuse existing owner-controlled history retention; do
not claim that clearing an attachment erases earlier tool effects. Diagnostic
output excludes captions, extracted text, transcripts, tokens, and file URLs.

| Area            | Required changes                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway         | `packages/gateway/src/channel.ts`, inbox decoding/storage, acceptance and processing, run binding, cancellation and error replies                 |
| Telegram        | `packages/channel-telegram/src/channel.ts` and `api.ts`: owner-first metadata parsing and protected, bounded downloads                            |
| Agent and store | Structured source provenance beside text-only messages, context assembly, title/recall handling, append-only migration and legacy-record fixtures |
| Host and config | Worker-owned extraction, temporary-file lifetime, explicit local voice configuration, composition in `apps/cli/src/channels.ts`                   |
| Documentation   | Telegram, chat, storage, configuration, architecture, development, and this phase's actual validation status                                      |

Use injected download/transcription functions and local fixture documents. Prove
unauthorized inputs cause no download; captions and attachment-only messages are
accepted correctly; legacy inbox records still decode; duplicates and restart
produce one run/answer; filenames cannot escape temporary storage; misleading
types, redirects, oversized streams, invalid UTF-8, corrupt PDFs, extraction
timeouts, and cancellation fail safely. Verify cleanup and that worker control
requests remain responsive during parsing. Check page/omission labels, context
overflow before inference, untrusted-source recall, and dictated-task confirmation.

Run focused tests and `bun run check` for each stage. Then use one authorized
Telegram chat to send a text file, a short PDF, an unsupported file, and, after
voice is enabled, a short recording. Check restart/deduplication, answer grounding,
and a dictated reminder's confirmation. Parser fixtures do not establish live
Telegram download behavior, real transcription accuracy, or model intent handling.

### Implementation and validation status

Stages 25a–25c are implemented with shared durable intake, optional structured
source provenance, schema migration 4, text-only provider requests, cancellable
PDF parsing and opt-in local voice. Voice runs cannot call write or external
tools; replies include the exact accepted transcript and request a subsequent
text confirmation for actions. See [Telegram usage](gateways/telegram.md#documents-and-voice),
[configuration](configuration.md#local-voice-transcription), and
[local compatibility evidence](attachment-probe.md).

Automated checks cover intake, download/extraction boundaries, migration rollback,
restart/deduplication, retention cleanup, URL authority, context overflow and voice
tool restrictions. `bun run check` passed with 937 tests across 65 files, including
formatting, lint and workspace type checks. Live Telegram downloads, model grounding/intent handling and
phone-recording accuracy still require the documented manual checks. Owner worker
configuration and permanent tool/model installation were not changed.

## Phase 26: Context for individual projects

Implemented on 2026-10-21. Reuses the explicit skill-selection and saved-snapshot
approach from phase 14, the memory service from phase 6, and existing session/task
ownership. See the [project context guide](projects.md). Live model and messaging
checks remain manual. The stages below record the implemented scope.

### Goal and selection rules

Let the owner explicitly select one project when creating a session or task.
Project instructions, facts, and selected notes should inform that work without
being injected into unrelated conversations. Begin with a single bounded context
file; add facts and selected-note behavior in separate stages.

Use named directories under `<POPPET_DATA_DIR>/projects/<name>/`, initially with
one `PROJECT.md`. Reuse the skill name, regular-file, UTF-8, symlink/hard-link,
and 8 KiB validation rules. A project name is an identifier, not an arbitrary path.
Do not infer a project from the working directory, conversation text, a link, or
a recalled message. Repository scanning, automatic fact extraction, project
renaming, and project-specific tool/provider credentials are outside this phase.

Owner interfaces:

```fish
bun run start projects list
bun run start projects show acorn
bun run start chat new --project acorn "Review the next milestone"
bun run start tasks add acorn-review --project acorn --cron "0 9 * * 1" --tz Europe/London "Review progress"
```

Messaging selection uses an explicit `/new --project acorn <message>` command,
combinable with the existing single skill. Options precede the prompt. Ordinary
follow-ups retain their saved selection; `/new <message>` creates an unscoped
session. Project and skill selection cannot grant additional tools or file access.

### Stage 26a: Instructions and durable selection

Save a nullable project snapshot on sessions and task definitions: stable project
name and the validated instruction text. Existing records migrate to `null`.
Read the file in the process owning the store when the session/task is created,
not in a separate CLI process before sending a worker command. Continuing a
session or executing a task uses its saved instructions even after the source
file changes or disappears, matching existing skill semantics.

Create a new session/task to refresh the snapshot in this stage. Phase 24 edits
retain project selection and its instruction snapshot. A task explicitly created
from a project chat inherits that chat's project snapshot through host metadata;
the model cannot supply another project's text or change scope. Scheduled
occurrence sessions must carry the same selection through restart and retry.
Keep delivery destinations, model selection, and skill snapshots unchanged.

Prompt composition keeps base tool/safety rules highest. Explicit current user
requests take precedence over saved preferences; within compatible saved
preferences, project-specific instructions refine global profile/personality.
Selected skills remain procedures subject to those rules. Label global and
project material separately and count everything toward the existing context
budget. Reject malformed or oversized new selections before resolving a model;
do not truncate project instructions or silently use global context instead.

Scope agent conversation search and reads to the session's selected project,
including `null` for unscoped sessions. Enforce the scope in the host/repository,
not through a model-supplied search argument. Otherwise a default recall could
reintroduce another project's details. Owner CLI inspection may still inspect
any session explicitly. Cross-project model recall needs a separate future
design; project selection is a context boundary within one owner's data, not
multi-user access control. Leave generated titles free of unrelated project data.

Expose selection and saved instruction provenance through `chat show`, task
inspection, messaging status, and worker-backed results. Do not imply that saved
instructions are the current contents of `PROJECT.md`. Listing/inspection of
project files should require neither provider login nor model inference.

### Stage 26b: Explicit project facts

Extend the existing fact service with an optional host-selected project scope.
Keep existing CLI memory commands global by default; add explicit `--project`
selection for project facts. Use the same key/value validation and create,
replace, and forget semantics. Store scope separately from the key, with a
composite uniqueness rule; do not fake scope with a string prefix that existing
global queries could accidentally include.

Each run reads current global facts and its current project facts once, retaining
that snapshot across model/tool turns. Saved project instructions remain fixed,
as above. Use one bounded project-fact budget, initially 8 KiB, within the overall
context limit. A conflicting project key refines the same global preference only
in that project; keep source scope visible in the prompt and inspection.

In a project chat, the memory tool targets that project by default and records
the host's project/run identity. It cannot choose a different project or write
global facts. An explicit request to change global memory is handled with the
owner's global CLI command or an unscoped chat, rather than silently switching
scope. Scheduled runs receive the selected facts but retain no memory-writing
tool. Profiles, project files, recalled text, notes, and skills remain context,
not authorization to save facts.

Deleting a project directory does not erase saved sessions, task snapshots, or
facts. Inspection reports orphaned project facts and provides the existing
explicit forget path. Do not introduce cascading history deletion or silently
move those facts into global memory.

### Stage 26c: Explicitly selected notes

Add an owner-edited, bounded `notes.json` in the project directory containing at
most eight relative note paths within the existing configured notes root. Validate
it with the same safe file rules; paths must resolve through existing note checks.
It is an explicit file selection, not a new filesystem root or a list of URLs.
Selecting a code repository never grants access to its whole tree.

Snapshot the selected path list with a new session/task, while reading current
note contents through existing read tools when needed. Treat note text as
untrusted data, not project instructions. In a project with a note selection,
constrain note search/read/write to that set using host context; selected paths
do not bypass normal write authorization. Without a selection, preserve the
existing explicitly configured notes-root policy and say so in inspection.
Do not eagerly load eight files into every prompt or build another notes index.

Missing/deleted notes produce a clear tool result without falling back to a
similarly named file. Keep bounds, omission markers, source paths, and existing
hard-link/symlink rejection. A scheduled review can read selected notes but cannot
edit them or add new selections. Changing the project note selection affects new
sessions/tasks; current ones retain their saved list.

### Implementation reach and completion gates

| Area          | Required changes                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Project files | A small validated loader using existing context-file/skill patterns; list/show without inference                                               |
| Persistence   | Session, task, and occurrence snapshots; project-scoped facts and recall queries; append-only migration, backfills, and exports                |
| Callers       | CLI parsing and `command-args.ts`, chat/task creation, worker schemas and composition, gateway `/new`/status, host-bound task and memory tools |
| Agent         | Prompt composition and budgets, scoped recall, fact snapshots, selected-note checks, bounded inspection                                        |
| Documentation | CLI, chat, tasks, memory, skills, storage, gateway usage, architecture, and stage status                                                       |

Test explicit selection through local CLI, worker, messaging, and chat-created
tasks; snapshot survival after source edits/deletion; old records remaining
unscoped; current facts loading once per run; key conflicts and scoped mutations;
and scheduled read-only behavior. Prove project/unscoped recall cannot bypass its
host scope by guessing a session ID, and note selection cannot escape the notes
root. Include invalid files, context overflow before inference, restart, task
retry, stale worker rejection, migration rollback, and deletion without history
loss. Use distinct behavior cases rather than copying every existing skill test.

Run focused tests and `bun run check` per stage. Manually create two projects
with conflicting harmless preferences, continue each after restart, and schedule
one review. Confirm selection in inspection and that unrelated facts/notes are
not supplied. Repeat explicit selection in one authorized messaging conversation.
Automated prompt assertions establish supplied context and tool limits; a live
model check is still needed for instruction-following and useful project reviews.

### Validation record

`bun run check` passed on 2026-10-21: formatting, lint, workspace type checks,
and 950 tests across 66 files. Project cases cover direct CLI, a real local worker
and gateway composition, task inheritance and retry, scoped facts and recall,
selected-note dispatch, file validation, stale-worker rejection, and atomic
migration rollback. Migration 5 retains legacy facts globally and backfills saved
sessions, tasks, and occurrence definitions as unscoped.

Tests use injected models and temporary stores. The owner's live database was not
opened or migrated. Live provider instruction-following, scheduled project review
quality, and platform messaging selection remain the
[manual project checks](projects.md#manual-validation).

## Phase 27: Actions the owner can review and approve

Stages 27a and 27c are implemented on 2026-10-22. They reuse note validation,
protected worker ownership, tool-call provenance and inspection patterns.
Stage 27b remains gated by the owner's explicit choice after the configured Apple
Notes create operation failed its destination-identity gate. See
[owner approvals](approvals.md). The sections below record the implemented local
scope and the separate external compatibility requirements.

### Goal and first version

Poppet prepares an exact proposed change, returns its ID and complete reviewable
content, and waits. The owner can inspect, approve, cancel, or let it expire.
Approval executes that saved proposal directly; it does not start another model
turn to reconstruct arguments. This is an opt-in proposal path. Existing explicit
interactive writes keep their current behavior unless the owner selects it.

The first proposal type is `create_note`, with a relative path and bounded UTF-8
content using existing note limits. It never replaces an existing note. This
keeps the first precondition precise and avoids promising an atomic comparison
and replacement against arbitrary external editors. Replacement/diff approval,
bulk approvals, action chains, recurring approvals, delegated approvers, and a
general workflow engine are outside the first delivery.

### Stage 27a: Immutable local proposals and owner approval

Add a narrowly defined proposal tool for interactive, tool-capable models. It
validates the note path/content and saves a proposal only on the owner's current
explicit request to prepare something for review. Fetched text, recalled content,
skills, notes, and project instructions cannot authorize a proposal. The tool's
completed result says `pending approval`; it must not claim the note was saved.

Persist the immutable proposal payload, payload digest/version, owner identity,
source session/run/call IDs, creation and expiry times, and intended result path.
Use a 24-hour initial expiry and existing bounded note content. Bind the record
to the active data directory and owner; proposal IDs are not bearer credentials.
Deduplicate proposal creation by the host's source run/call identity, with the
creation receipt committed in the same transaction. Editing a proposal means
cancelling it and creating a new ID, never changing an already reviewed payload.

Local owner commands:

```fish
bun run start approvals list
bun run start approvals show $proposal_id
bun run start approvals approve $proposal_id
bun run start approvals cancel $proposal_id
```

`show` displays the exact destination, complete content, source, expiry, and
current state. A shortened list entry is not the full review. Approval responses
identify that same immutable payload and its durable outcome. Keep approval and
cancellation CLI-only initially, through the protected worker socket when it is
running and the ordinary single-owner path otherwise. A lost worker response
must not trigger local fallback or another execution.

Use a small persisted lifecycle: pending, executing, completed, failed, cancelled,
expired, or uncertain. Expiry can be projected when inspecting/claiming a pending
record; it does not require another scheduler. Approval atomically claims a
still-pending record after checking identity, expiry, payload integrity, current
notes-root policy, safe path, and the target's absence. Cancellation and approval
race through that same claim. A duplicate approval returns the saved state or
receipt; it never dispatches again.

Extend the shared note implementation with safe create-only publication. A
check-then-overwriting-rename is insufficient: another writer may create the
target between those steps. Revalidate paths at execution and use an operation
that cannot replace an existing target. Leave the existing file untouched when
the precondition no longer holds. Reuse private temporary files and cleanup.

Persist `executing` before dispatch, release the database transaction, then
execute through the same owner and mutation coordination as ordinary tools.
Persist a bounded outcome receipt afterward. Waiting for owner approval holds
neither the agent permit nor an open transaction. Do not invent a model run to
record execution; link the separate approval receipt to its originating tool call.

If cancellation or a crash occurs after dispatch and completion was not durably
recorded, preserve `uncertain`. Recovery never changes it back to pending or
automatically retries. The owner inspects the target and receipt before preparing
a replacement proposal. Graceful cancellation should let a started local atomic
write and receipt finish together where possible, as existing note writes do.

### Stage 27b: One supported external action

Choose one actual configured integration and a specific action after inspecting
its current schema and behavior. The compatibility probe must establish target
identity, authorization, stable argument interpretation, relevant state/version
preconditions, timeout semantics, and whether an idempotency key is supported.
Do not expose arbitrary MCP mutations as approvable simply because their schema
can be displayed.

For the selected action, store the exact server/tool identity, validated argument
payload, concrete account/resource/destination, and the reviewed precondition.
The host creates the preview from validated fields; model prose cannot substitute
for the actual payload. Redact secret fields and reject actions whose meaningful
effects cannot be reviewed without exposing credentials. Do not put raw arguments
in diagnostics. Configuration changes or a different tool/schema identity require
a new proposal rather than approving an old payload against a new integration.

At execution, recheck current integration permissions and the action's supported
preconditions. A changed target fails for review. If the integration cannot
enforce a required precondition at mutation time, exclude that operation from
the first supported action instead of claiming race protection from a prior read.
An external idempotency key, when supported, is tied to the proposal ID. Without
one, durable single dispatch still cannot prove exactly-once remote execution;
unknown outcomes remain uncertain and are not replayed.

### Stage 27c: Scheduled proposals and owner notifications

Only after Stage 27a, allow an explicitly configured reporting task to prepare
the supported note proposal. Keep the ordinary scheduled note/memory/MCP write
tools unavailable. Add a separate host permission to create this proposal type;
it grants no permission to execute it. The owner must opt in when creating the
task and choose the allowed proposal destination. A task prompt or skill cannot
grant that permission itself. Monitoring tasks do not propose actions initially.

Bind a scheduled proposal to its occurrence and saved task revision, with at most
one proposal per permitted action in that occurrence. A task edit/deletion or a
changed permission invalidates pending proposals from that definition at approval
time. Preserve completed receipts when source tasks/history are cleared; cancel
pending work explicitly rather than losing its audit trail through a cascade.
Use Phase 24's revision/snapshot rules when available; otherwise implement that
narrow definition binding before enabling scheduled proposals.

Notify the owner of a proposal through a separately identified durable gateway
delivery, retaining existing destination authorization and uncertain-send rules.
A notification is not an execution receipt. Duplicate runs or notification
delivery cannot approve the action. Keep approval local until a separate
owner-authenticated messaging command binds the exact proposal ID and payload;
quoted messages, reactions, another sender, or a bare conversational "yes" do
not constitute approval. Cross-channel approvals are outside this stage.

### Implementation reach and completion gates

| Area                     | Required changes                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Store                    | Proposal/receipt records, unique source identity, atomic state claims, expiry and recovery, append-only migration and inspection       |
| Agent and notes          | Narrow proposal tool and instructions, source-bound receipts, shared create-only note publication, bounded previews                    |
| CLI and worker           | Approval list/show/approve/cancel schemas, explicit action discriminators, owner checks, bounded dispatch and duplicate-safe responses |
| Optional external action | One typed integration adapter reusing existing tool validation/transport and recording preconditions and uncertain results             |
| Scheduled follow-up      | Explicit task capability and revision binding, occurrence deduplication, gateway proposal notifications without direct execution       |
| Documentation            | CLI, chat, notes, tasks, MCP permissions where applicable, storage, architecture, and validation status                                |

Test that proposing has no note side effect, payloads are immutable, unauthorized
sources cannot approve, and expired/cancelled/changed-policy proposals cannot
execute. Race two approvals, approval versus cancellation, and an external file
creation versus publication. Prove no overwrite, one dispatch, duplicate receipts,
and correct uncertainty after a simulated crash or lost response. Exercise path
escape/link rejection, payload limits, receipt rollback, migration/restart, and
secret-free diagnostics. External-action fixtures must cover changed preconditions
and remote acceptance followed by a lost response.

Run focused tests and `bun run check` per stage. Manually prepare a harmless note,
review its full content, approve it, and verify repeated approval does nothing.
Cancel and expire separate proposals. Only then validate the chosen external
action with a disposable target and a live authorized account. Scheduled proposals
also need one live notification check. Local fixtures cannot prove an external
service's idempotency or a real model's ability to prepare useful proposals.

### Validation record

`bun run check` passed on 2026-10-22: formatting, lint, workspace type checks,
and 968 tests across 67 files. Approval cases cover exact source-call binding,
immutable complete previews without publication, owner boundaries, expiry,
cancel/claim races, atomic create-only publication, receipt rollback and crash
uncertainty, lost worker responses, migration rollback, scheduled permissions and
revision binding, source-task cleanup, and separate notification deduplication
and uncertain-send recovery.

Tests use injected inference, temporary stores and real local note publication,
worker sockets and delivery queues. The owner's live database was not opened or
migrated. Live model behavior and a real scheduled messaging notice remain the
[manual approval checks](approvals.md#validation).

The configured `apple-notes-mcp` 2.15.1 create operation was inspected locally.
Its account/folder-name resolution cannot enforce the exact reviewed folder
identity at mutation time, so no external adapter was enabled. The owner explicitly
chose to retain that gate; Stage 27b remains separate future work.

## Phase 28: Browser login state across requests

Planned only. Extend the phase 21 browser's owned-daemon lifecycle rather than
replacing it. Keep fresh per-run browser state as the default. This phase is
independent of project context; reusable login state must not be selected by
project instructions or model-generated paths.

### Goal and compatibility gate

Allow one explicitly enabled owner profile to preserve website login state
between eligible interactive requests. Browser processes, sockets, references,
and temporary runtime directories still belong to one run and are closed at
its end. Persist only the browser profile needed for login, not a daemon running
indefinitely or old page-element references.

First verify the pinned agent-browser/Chromium combination's supported mechanism
for a persistent profile and an attended login window using the existing direct
daemon protocol. Probe a disposable local test site with a harmless cookie,
restart, and check that storage is retained. Also verify two-process contention,
crash recovery, shutdown, profile path/config precedence, and whether unrelated
environment/configuration is loaded. Read the pinned upstream documentation and
runtime behavior before choosing flags; do not assume a CLI feature is supported
by the daemon interface.

Stop at the compatibility gate if the runtime cannot keep profile ownership,
domain policy, bounded startup/shutdown, and cancellation intact. Do not replace
the owned transport with detached CLI processes, copy the everyday browser
profile, or work around unsupported persistence by exporting cookies into the
model context. Record the tested versions and exact supported launch contract.

### Stage 28a: Protected storage and exclusive ownership

Use one fixed owner profile below the Poppet data directory, separately from each
run's temporary HOME/socket/config directory. The model cannot choose its path,
create profiles, import cookies, or read profile files. Reject symlinked roots,
unexpected ownership, and unsafe permissions before launching. Create directories
with mode `0700` and a restrictive process umask; protect metadata and browser
state from other local users. Filesystem permissions are not an encryption or
backup guarantee; document that profile backups contain login secrets.

Reuse the existing owner-lock pattern for an exclusive profile lease covering
startup through confirmed process exit. It must work across worker and direct
CLI processes. A busy profile fails clearly instead of opening a second browser,
copying live files, falling back to a fresh profile, or attaching to an arbitrary
existing process. Use the lease identity and owned-process information for stale
lock recovery, not a PID alone. Never kill an unrelated browser to free a profile.

Separate persistent and disposable paths in cleanup. Stop the owned daemon and
browser before releasing the lease. If exit cannot be confirmed, retain a blocked
profile state for inspection/recovery rather than permit concurrent reuse. Normal
run cleanup deletes temporary sockets/configuration, never the persistent profile.
Do not silently delete or rebuild a profile after corruption.

### Stage 28b: Attended login and explicit request selection

Add owner CLI commands to inspect the profile and open an attended login session
through the same protected lifecycle. The owner enters passwords and completes
MFA directly in the owned browser. Do not ask the model to manage a password
vault, read cookies, solve challenges, or export credentials. The login session
uses the same configured domain policy and exclusively owns the profile until
it is closed.

For the first version, allow selection only on explicitly created interactive
CLI sessions, for example `chat new --browser-profile owner <message>`. Persist
that choice and the profile generation in session metadata; follow-ups retain
it. No selection means today's fresh state. Worker-backed CLI chat must carry
the same explicit metadata, and an old worker must reject the new request rather
than ignore it. The model cannot turn profile access on during a run.

Keep profile use unavailable to scheduled tasks and messaging conversations in
this stage. Their authentication, account/destination binding, and unattended
behavior need a separate delivery gate. Even selected interactive sessions retain
the existing browser tool set and action policy. Logged-in clicks or submissions
still require the owner's current explicit request; persistent authentication
does not turn browser actions into read-only tools or approve future actions.

Reapply current allowed-domain policy at every launch. A profile does not grant
permission to other domains or expose provider credentials in the child process.
Verify the pinned runtime's handling of restored pages, redirects, service workers,
and non-HTTP schemes against that policy. Preserve the documented limitations of
browser network isolation rather than claiming stronger isolation from a saved
profile. A separate Phase 27 integration would be needed for durable reviewed
browser actions; this phase does not implement one.

### Stage 28c: Inspection, clearing, and recovery

Inspection reports configured versus selected state, profile generation, lease
owner/liveness, last lifecycle failure, and whether reuse is blocked. It does not
list cookie values, site storage, visited URLs, page text, or arbitrary profile
filenames. Do not claim that a stored profile is currently signed in without
visiting the relevant site in an explicitly authorized request.

An explicit owner clear command requires exclusive ownership and refuses while
the profile is in use; the owner can cancel/close the active session first. Persist
a clearing state and invalidate its generation before removing only the validated
profile directory. Keep a small non-secret lifecycle receipt. An interrupted clear
remains blocked until explicit recovery finishes it. Sessions bound to the old
generation must request a new selection, preventing cleared state from being silently
recreated under an old authorization. Do not restore a cleared profile from a
cache or copy. Explain that local clearing does not revoke website sessions on
the server; server-side sign-out/revocation is a separate owner action.

Recovery uses owned-process shutdown and validated stale-lease checks. It never
launches a browser merely to inspect status, automatically repairs a corrupt
profile, or removes another process's lock. Keep reset/recovery commands explicit
and narrow; generic cookie import/export and multiple profiles can wait.

### Implementation reach and completion gates

| Area                        | Required changes                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser                     | `packages/browser/src/config.ts`, `browser.ts`, and `browser-process.ts`: verified profile launch, lease, split lifetimes, cancellation and cleanup |
| Config/credentials patterns | Protected fixed profile path, metadata/generation, owner-lock reuse, redacted status and explicit clear                                             |
| Store and callers           | Nullable session selection, migration, CLI parsing/`command-args.ts`, worker requests and runtime composition; scheduled/messaging rejection        |
| Documentation               | Browser setup/lifecycle/limits, CLI, configuration, storage, worker behavior, and the pinned compatibility evidence                                 |

Use injected launchers and temporary profiles to test default fresh state,
explicit selection, policy changes, generation invalidation, safe clear, lock
contention, stale-process identity, symlink/permission failures, crash recovery,
and cleanup that preserves persistent data. Check failed shutdown cannot release
the profile for another process. Assert no cookies or profile contents enter
model prompts, journal records, logs, or diagnostics.

Run focused tests and `bun run check`. The completion gate also needs an attended
check with the pinned real runtime: establish harmless login state on a controlled
site, close the run, reuse it in a second request, demonstrate fresh default state
in another session, reject concurrent ownership, then clear and verify old
selection is invalid. Use a disposable live account only after those checks.
Fake process tests cannot establish actual cookie persistence, MFA behavior, or
complete browser-process cleanup.

## Phase 29: A useful `poppet doctor`

Planned only. Combine existing configuration, auth, task, worker, gateway, MCP,
and browser inspection. This phase can be delivered independently of phases
24–28; report those capabilities only when they exist. Do not create another
monitoring service or background health poller.

### Goal and output contract

One `poppet doctor` invocation should explain what needs attention and the next
owner action. Default checks are read-only and bounded. They do not make model
requests, refresh tokens, run MCP servers/tools, start Chromium, send messages,
restart the worker, install dependencies, migrate databases, or repair state.
Optional capabilities that are not enabled are skipped, not failures.

Each result has a stable check ID, status (`ok`, `warning`, `error`, or `skipped`),
observation time/source, short explanation, and an actionable next step when
needed. State whether an observation is live local state, saved metadata, or not
checked. A saved successful model call is not proof of current provider reachability;
a configured executable path is not proof that its runtime can launch.

Proposed exit behavior: `0` when no actionable problem is found, `1` for actionable
warnings/errors, and `2` when required inspection could not be completed. Disabled
optional capabilities do not affect the exit code. A missing installation/data
directory is reported with setup guidance without creating it. Invalid config
should still allow independent worker/filesystem checks where safely possible.

### Stage 29a: Local inspection without runtime side effects

Start with a small explicit collector using existing status/validation helpers.
Compose only the services needed for inspection, not the full inference/worker
runtime. Separate readers from constructors that acquire ownership, initialize
directories, recover runs, or write migrations. In particular, the normal store
layer cannot be used merely because its `status` method looks read-only.

| Check          | Evidence and next-step behavior                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration  | Effective non-secret settings and validation errors; identify the selected data directory and config source                                       |
| Worker         | Protected socket reachability and existing platform service status, distinguished from one another; suggest the relevant status/start/log command |
| Authentication | Provider connection metadata and credential-file safety without access-token refresh; distinguish missing, expired, and unverified saved state    |
| Provider holds | Saved hold reason and retry time, not a fresh inference probe; explain whether waiting or reconnecting is appropriate                             |
| Scheduled work | Bounded recent failure/interruption counts and IDs, next due work, and stale running state without changing it                                    |
| Delivery       | Pending/failed/uncertain delivery counts and age; tell the owner to inspect uncertain sends before retrying                                       |
| MCP            | Enabled configuration, command availability and allowlist consistency; no server discovery or tool execution                                      |
| Browser        | Enabled configuration, executable paths, domain policy and supported-version metadata when available; no process launch                           |
| Context files  | Existing validated profile/personality/selected skill files where relevant, with errors rather than their private contents                        |

Use saved status readers for credentials; do not call an access-token resolver or
assume every provider's connection-status implementation is free of writes or
network access. Report configured-but-unverified providers honestly. Platform
service inspection may use existing read-only OS commands, with bounded output
and deadlines; it must not bootstrap, unload, or modify a service.

When no worker owns the store, a new read-only inspection path may query supported
schema metadata and bounded existing projections. It must not create a database,
apply migrations, acquire the writer's owner lock, checkpoint WAL, or mark runs
interrupted. Verify that opening it creates no WAL/SHM or other files. If the
runtime cannot safely inspect a particular state without writes, report that check
as unavailable. Do not force SQLite immutable mode and silently ignore live WAL
data. An unknown/newer schema gets compatibility guidance, not best-effort queries
against guessed columns.

### Stage 29b: Worker observations and actionable diagnosis

Prefer a bounded status request to the existing protected socket when a worker
is reachable. Read its configuration identity, task/provider holds, gateway
connection observations, and delivery summaries without claiming new work or
waiting for the agent permit. Add an explicit inspection discriminator if the
existing response lacks a required field; old workers should produce a clear
unsupported-check result.

Compare the CLI's selected config/data directory with the running worker's
reported identity. Show a mismatch and an explicit restart/configuration next
step rather than silently combining unrelated snapshots. A stopped worker,
unreachable socket, unhealthy messaging connection, and mismatched installation
are distinct findings. Saved gateway observations retain their timestamps and
must not be labelled a fresh remote connectivity check.

Give each operation a short deadline, initially 2 seconds per local/socket check
and 10 seconds overall. Independent failures should not suppress useful results
from other checks. A timed-out worker request must not fall back to a mutable
local store owner. Do not read or print arbitrary logs to guess a diagnosis;
link the owner to the appropriate bounded inspection command instead.

As other phases land, add only their specific saved-state checks: attachment
processing failures, missing project selections, expired/pending approval counts,
or a blocked browser-profile lease. Do not implement those future storage shapes
early or automatically clean them up. Keep live network probes and a `--fix`
mode outside this phase; existing explicit verification commands remain the way
to test live account/tool access.

### Stage 29c: Human output and stable JSON

Render a short overall result followed by actionable findings and their commands.
Keep successful checks compact. Add `--json` with a versioned, documented shape
using the same check results and exit codes, not a separate diagnostic execution
path. Include provenance/timestamps so scripts cannot mistake saved observations
for current service health. Bound lists and indicate omitted counts.

Construct output from an explicit allowlist of safe fields. Never serialize whole
config objects, raw auth/provider errors, token-bearing keys/URLs, tool arguments,
message text, note content, attachment text, cookies, or environment dumps.
Use existing neutral diagnostic styling for informational CLI output and reserve
error styling for actual failures. Recommendations are inert text, expressed
using real existing commands; doctor never executes its own suggested repair.

### Implementation reach and completion gates

| Area                | Required changes                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| CLI                 | Command registration, a focused doctor collector/renderer, bounded human/JSON results, exit codes and exports |
| Existing services   | Reuse config/auth/MCP/browser inspection; extract genuinely read-only readers only where needed               |
| Store/tasks/gateway | Supported read-only diagnostic queries and bounded worker summaries, with no migration/recovery side effects  |
| Worker              | Explicit status fields, config identity and deadlines using existing protected transport                      |
| Documentation       | CLI reference, troubleshooting/worker/configuration guides, JSON contract, check provenance and known limits  |

Test a clean setup, absent data directory, bad config, expired/missing credentials,
provider hold, failed work, uncertain delivery, disabled optional tools, missing
executables, and unreachable/mismatched/old workers. Use injected status providers
and temporary databases, including WAL and unsupported-schema fixtures. Verify
the command leaves files, schema version, run states, and credential bytes
unchanged; creates no files on an uninitialized installation; performs no network
calls, model requests, token refreshes, or tool/browser launches; and returns
partial findings within its deadlines. Test human/JSON agreement and secret
redaction in values, object keys, nested causes, and malformed configuration.

Run focused tests, CLI checks, and `bun run check`. Manually run doctor with the
worker stopped and running, and with one deliberately broken disposable config.
Confirm useful next steps and no repairs, launches, paid calls, or state changes.
A passing doctor reports the checks it actually performed; it does not establish
live provider access, website login, MCP correctness, or messaging delivery.

## Phase 30: Calendar briefings and weekly reviews

Planned configuration trials, not a new native integration. Start with existing
MCP reads, notes, conversation recall, local skills, and reporting tasks from
phases 7, 13–14, and 20. Phase 26 can improve project selection later but is not
required for a review of explicitly named notes. Do not implement a calendar
package or workflow engine before these trials reveal a concrete missing need.

### Stage 30a: Check capabilities and choose bounded inputs

Inspect one owner-authorized calendar integration's actual tools and permissions.
Choose the exact calendar/account, reporting timezone, fields to include, maximum
date window, and source limits. Verify that the chosen reads support date bounds,
pagination, all-day events, recurring instances, timezone offsets, and explicit
failure results. Record the tool identities and allow only the required reads
in `scheduledTools`. A claimed read-only annotation is not enough to authorize
arbitrary tools, and no calendar write tool becomes scheduled by this trial.

Resolve the reporting window from a trusted time source. Currently the agent adds
UTC time for interactive task management, while `packages/tasks/src/scheduler.ts`
passes the saved prompt to a read-only run without adding an occurrence timestamp.
First test a fixed date range interactively. For recurrence, use a verified
read-only integration time/window capability if one exists. Otherwise record
host-supplied scheduled/current time as a focused follow-up requirement and stop
the recurring trial there. Do not infer today's date from model knowledge or
invent unsupported prompt templates.

For weekly reviews, select a small named note set and any explicitly relevant
conversation sources. Keep existing notes-root and recall permissions; no
repository scan or automatic global-memory harvesting. Confirm whether the
sources actually carry dates. An undated note is not evidence of work completed
this week. Capture missing capabilities separately from configuration mistakes.

### Stage 30b: Calendar briefing skill and one reporting task

Write one owner-reviewed `calendar-briefing` skill with a concrete output:
reporting window/timezone, today's agenda, overlaps apparent in the returned data,
and preparation notes supported by those events. Include source identities and
retrieval time. Distinguish an empty calendar from a failed, incomplete, or
truncated response. Do not infer free time from partial results or follow links
inside event descriptions without the existing URL authorization.

Run it interactively against the fixed range first, then create one ordinary
recurring reporting task only after the time-source gate passes. Start with local
results; add one explicitly chosen private delivery destination after the owner
has reviewed the output's private fields. Existing destination authorization does
not itself establish that a channel has the intended audience. Keep schedule,
provider holds, retry/uncertain delivery, and cancellation behavior unchanged.

The briefing cannot accept invitations, move events, message participants, save
facts, or create more tasks. Event content remains untrusted. Future reviewed
calendar actions depend on a separately implemented Phase 27 action adapter,
not on this skill's prose. A daily briefing intentionally reports each scheduled
run; it does not need monitoring baselines unless the owner separately asks for
change-only notifications.

### Stage 30c: Weekly review skill and measured follow-up

Write one `weekly-review` skill for a specified project/source set and date range.
Report supported progress, unresolved decisions, and proposed next steps, citing
note paths or session/message IDs. Keep facts separate from recommendations and
mark gaps or undated material. Do not present an old recalled plan as current
completion evidence. With Phase 26, select its project explicitly; otherwise
keep the source set in the task prompt/skill rather than claiming project scope.

Test one fixed-week review interactively, then one recurring reporting task after
the same time-source gate. Output remains a report. Saving a review note,
changing tasks, approving actions, or updating memory requires a separate explicit
owner request and the relevant existing permissions. Record whether results were
useful over at least two reporting windows, plus omitted sources, tool failures,
context-limit failures, and owner corrections. Avoid adding custom code merely
to improve a single prompt.

### Reach, validation, and completion gate

The expected deliverables are documented setup, two owner-reviewed skill files
in the owner's data directory, one task per accepted workflow, and a small
capability-gap record. Repository documentation/examples may be added when the
trial is actually authorized. No runtime code or new dependency is expected;
any missing time, pagination, or source-selection capability gets its own focused
implementation plan before coding.

Use disposable calendar fixtures or controlled live test events for an all-day
event, overlapping events, a recurring instance, an empty window, and a timezone/
DST boundary. Check partial/failing reads, source bounds, and instructions embedded
in descriptions. For reviews, include dated and undated notes and an outdated
conversation statement. Inspect actual tool receipts and task results instead
of judging only the final prose. Existing commands still handle pause/resume,
provider holds, and delivery; avoid duplicating their implementation tests.

Complete each trial only after one fixed-window interactive result and, if its
time source is supported, two scheduled windows have been inspected. Live account
and delivery checks require the owner's chosen integration/destination. Planning
these trials or writing the skills does not establish live calendar correctness
or useful weekly review quality.

## Phase 31: Command execution and approval

Implemented on 2026-10-22 with separate opt-ins for commands, automatic reads,
fixed scheduled proposals and advisory review. The Bun 1.4.3 macOS compatibility
probe passed. Real-model behavior, live delivery and reviewer usefulness remain
manual checks; Linux CI remains unverified for this branch. See
[command execution](commands.md). This phase reuses Phase 27's local lifecycle;
its external-action stage remains gated.

### Goal and delivery boundaries

Let the owner ask Poppet to run a local command, review the exact invocation,
and approve it once. Add deterministic automatic permission for a small set of
read-only invocations only after the manual path works. Reuse existing proposal
records, protected worker ownership, tool-call provenance, and durable receipts.
Approval executes saved arguments directly without another model turn.

The first delivery is CLI-only, disabled by default, and runs trusted local
programs under the owner's OS account. It supports one executable and argument
array in a selected working directory. Shell strings, pipelines, redirections,
PTYs, interactive stdin, background services, privilege elevation, remote
mutations, secret-bearing arguments, session-wide approval, and permanent
approval are outside this delivery. Build/test commands can execute project
code and always require owner approval. Do not classify them as read-only.

This is approval for an invocation, not proof of its complete effects. The
working directory does not restrict filesystem or network access. Removing
credential environment variables does not prevent an owner-account process
from reading credential files. Admit only owner-trusted programs and workspace
code. Untrusted-code execution requires a separately verified OS isolation
design; process timeouts and command classification do not provide one.

Phase 27's external adapters remain gated. Do not add shell-based routes for
external actions as part of this phase or claim that command rules enforce
network isolation. Initial messaging and voice requests cannot obtain command
access. Scheduled runs get no execution permission, including automatic reads.

Deliver Stages 31a-31c first. Stages 31d-31f are separate follow-ups, each with
its own acceptance gate. No Tirith dependency, policy language, shell parser,
general workflow engine, or additional approval UI is required.

### Stage 31a: Execution contract and runtime compatibility

Inspect the pinned Bun version, currently 1.4.3, and existing browser/MCP child
process handling. Verify supported behavior on macOS and Linux CI with
disposable fixtures before exposing a model tool. Prefer the existing runtime
and built-in process APIs. If `Bun.spawn` cannot meet the lifecycle requirements,
probe the built-in `node:child_process` API before considering another dependency.
Do not implement a shell launcher to work around missing process controls.

The probe must establish argument preservation, explicit cwd/environment,
ignored stdin, concurrent stdout/stderr draining, spawn failures, normal and
nonzero exits, timeout, cancellation, and reaping. Include a child that ignores
SIGTERM, one that spawns a descendant holding a pipe open, and a launcher that
exits before its descendant. Establish process-group cleanup where supported;
killing the direct child alone is insufficient for ordinary build/test tools.
Record the selected API, platform behavior, cleanup deadline, and limitations.
An unsupported platform must refuse command access with an actionable reason.

Start with one active command per owner process, a 60-second execution deadline,
and bounded cleanup: two seconds for graceful termination, then three seconds
for forced termination and reaping. Count bytes while reading both pipes.
Retain at most 64 KiB combined and fit model-facing results within the existing
`toolBytes` budget, reserving space for status and truncation metadata. Stop a
command that exceeds the capture limit. Never use unbounded `.text()` or wait
forever for a descendant to close an output stream. Tune these initial limits
only from the probe's evidence, and document any change before implementation.

Process groups cannot contain deliberately escaping code. Worker death can also
leave processes alive unless a verified runtime mechanism prevents that. Report
these limits explicitly; recovery must not signal an old saved PID that the OS
may have reused. If cleanup of ordinary admitted commands cannot be bounded,
stop at this gate instead of exposing them. Supporting hostile subprocesses or
guaranteed cleanup after forced owner-process death requires separate isolation.

Acceptance: the probe passes without model inference or live owner data, leaves
no fixture processes behind, and distinguishes tested cleanup from containment
claims. No command permission is enabled merely by running the probe.

### Stage 31b: Host permissions, typed proposals, and command policy

Add opt-in command settings through the existing configuration source. Initially
accept an `enabled` flag and explicit absolute executable paths. Default to
disabled and an empty list. Resolve and validate owner-managed executable
identities on the host. Do not resolve model-supplied program names through PATH
or discover executable permissions from project instructions or tool results.
Configuration validation/inspection must not execute the configured programs.

Add an explicit `--commands-root <directory>` option to eligible CLI chat sends.
Resolve the directory on the host and attach the capability to that request
and run. It expires with the run and is not inherited by the next message,
resumed session, project, scheduled task, or messaging conversation. Global
configuration permits the feature; it does not grant every run command access.
Capture the canonical root and its filesystem identity. The capability limits
cwd selection, not access by the launched program to other files.

Expose one `poppet_commands.request_command` tool only to eligible tool-capable
runs. Its arguments are an executable selected from host-permitted identities,
an ordered string argument array, and a cwd relative to the granted root.
Tool instructions require the current owner's request; documents, project
instructions, history, and command output cannot authorize a command request.
Reject excess fields, NUL, ill-formed Unicode, cwd escape or linked-directory
escape, more than 128 arguments, and more than 16 KiB of argument bytes. Preserve
argument boundaries and empty strings. Do not accept environment, shell code,
credential references, or a model-provided authorization verdict. Shell/wrapper
entrypoints and inline code evaluation are unsupported in the first delivery;
only the explicitly admitted local tool forms reach manual review.

Use a deterministic policy with three results: deny, require owner approval, or
allow by an explicit read rule. Stage 31b has no automatic allow rules. Invalid
requests, absent grants, disabled/revoked executables, unsupported forms, and
exceeded limits are denied. Every admitted invocation requires owner approval.
Unrecognized arguments cannot become automatic permission. Include a stable
reason and policy version in the host decision. A model explanation or a
conversational "yes" cannot change that decision.

Extend the persisted payload schema with a versioned `execute_command` variant,
keeping the existing `create_note` encoding readable without rewriting its
bytes or digest. Bind the command record to:

- The exact executable path and observed identity, ordered argv, canonical cwd
  and root identity, and the original run capability.
- The host-created, minimal non-secret environment and execution/output limits.
  Include the actual PATH and private temporary HOME/TMPDIR policy in review.
  Never inherit the worker environment, credential store, provider/channel keys,
  loader injection variables, or caller-selected environment overrides.
- Owner, source session/run/tool-call IDs, payload digest/version, policy version,
  creation time, and the existing 24-hour expiry.

Create private temporary directories at dispatch using the reviewed environment
policy. Their generated paths are the only deferred environment values; record
the actual paths/identities in the attempt receipt and clean them up afterward.
Arguments must be reviewable without hiding their effect. Reject known
secret-bearing invocation forms rather than displaying redacted arguments and
executing an undisclosed value. Do not claim that arbitrary command output can
be reliably stripped of every possible secret.

Build previews from validated fields, with a losslessly escaped argv array,
cwd, permissions, environment policy, limits, digest, source, and expiry. Escape
terminal controls and bidi characters. A display command line is explanatory;
it is never parsed for execution. If the complete preview cannot fit the tool
result budget, reject proposal creation before committing a pending record.

Use the next append-only migration where storage changes are needed. Extend
the existing repository and approval service by action kind, including their
currently note-specific provenance queries, receipts, list summaries, and stale
scheduled-permission checks. Do not replace them with an arbitrary JSON action
registry. Proposal creation and its tool receipt remain one transaction, and
the payload must match the active recorded source call after host resolution.

Acceptance: disabled, stale, voice, messaging, scheduled, and ungranted runs
cannot expose or invoke the command tool. Proposing spawns nothing. Existing
note proposals and receipts still decode, approve, expire, and recover correctly.
Test changed grants, malformed/oversized argv, literal shell metacharacters,
symlinks, source-call mismatch, preview escaping, and receipt-budget rollback.

### Stage 31c: Exact owner approval and bounded execution

Extend `approvals list/show/approve/cancel` to display and handle command records.
`show` returns the complete structured request. Keep approval/cancellation local
through the protected worker socket, or the ordinary exclusive-owner path when
the worker is absent. An ended source run does not itself authorize execution;
the later local approval grants one dispatch of its saved, unexpired request.
No approval tool is exposed to the model.

Immediately before claiming, recheck owner, digest, expiry, current command
settings, admitted argument form, executable identity, and cwd/root identity.
Revocation or observed replacement requires a new proposal. These checks do not
freeze every workspace input or atomically bind path lookup to OS execution.
Document that the command reads live workspace files, and require trusted
executable installations. Do not promise an atomic filesystem precondition that
the selected process API cannot enforce.

Atomically claim the pending record and save the authorization authority and
time before spawning. Release the database transaction before process work.
Execute the recorded argv directly under the limits proven in Stage 31a. Reuse
the same owner-wide command permit for local and worker paths. Waiting proposals
hold no database transaction, agent permit, process, or temporary environment.
If a command permit is unavailable, leave the proposal pending and explain that
another command is active rather than claiming it into an unbounded queue.

The note publisher's uninterruptible write region must not make an entire command
uninterruptible. Protect only the claim/dispatch transition and bounded receipt
and cleanup work. Handle cancellation during every phase, including just after
spawn. During a live owner process, an interrupted request must stop/reap its
command or preserve uncertainty when cleanup cannot be confirmed.

Persist a bounded receipt with proposal ID/digest, authorization authority,
policy version, start/end times, spawn status, exit code/signal, termination
reason, stdout/stderr with byte counts and truncation flags, and cleanup status.
Normal zero exit completes the invocation; a known nonzero exit fails it and
may still have changed files. Timeout, interruption, lost completion, or failed
cleanup after dispatch produces `uncertain`. A proven pre-spawn failure is
`failed`. No state promises rollback or verification of the intended effect.

Duplicate approvals return the saved state/receipt and never spawn again.
Cancellation only wins while pending; it is not a command to undo started work.
Lost worker output must never trigger local fallback. Restart converts abandoned
executing records to `uncertain`, with no automatic retry. Preserve that receipt
even when the originating task/session is later inspected or cleaned up.
Receipt failure after a child exits also remains uncertain for recovery.

Return a pending proposal ID to the original model turn and finish normally.
Approval later runs without inference. Command output becomes model context only
when the owner explicitly selects a receipt with `--command-receipt <id>` on a
CLI follow-up. The host validates ownership and project selection and attaches
only that bounded receipt as untrusted context. This option grants no execution
permission and exposes no model tool for browsing other receipts. Escape terminal
controls and bidi characters in displayed output, and mark invalid text decoding
or truncation explicitly. Do not automatically inject private command output
into a messaging conversation or unrelated project.

Acceptance: use real disposable subprocesses to verify exact argv/cwd/env,
separate output streams, nonzero/partial effects, time/output limits, interruption,
and descendant cleanup. Race duplicate approvals and approval/cancellation.
Simulate crashes around claim/spawn/receipt, changed executable/cwd before
approval, lost worker responses, and restart. Prove one dispatch and no retry.
Keep diagnostics to IDs/status/reasons; raw argv/output stays in the deliberate
owner review and private receipt paths. Approval execution makes no model call.

### Stage 31d: Narrow automatic reads

Add a separate owner opt-in, `commands.automaticReads`, defaulting to false.
The per-run CLI grant is still required. Start with exact supported system
`uname -s` and `uname -m` invocations after Stage 31a verifies their executable
identity and behavior on each supported platform. A platform without an admitted
implementation has no such rule. No generic executable-name allowlist, argument
prefix match, model-provided "read-only" flag, or regex over shell text grants
automatic permission.

Rules inspect the resolved executable identity, complete ordered argv, host
environment, cwd capability, and limits. Changed flags or an unrecognized form
take the manual path only if otherwise admitted; hard denials stay denied.
Do not automatically allow Git, package managers, build/test tools, interpreters,
find/exec forms, or tools that read project configuration or invoke plugins.
Any later file-reading rule needs explicit input-path and configuration rules,
including link escapes, option injection, and access to private Poppet data.

An allowed read uses the same durable claim, bounded executor, receipt, and
uncertainty handling as an owner-approved command. Record rule ID/version as
the authority and label it `allowed by rule`, never `approved by owner`.
Create the record, source-call binding, and authorization before dispatch.
Atomically save its final tool result with the completed receipt where possible;
failure after dispatch cannot return it to a runnable state. Output is untrusted
tool data subject to the existing model/tool budget.

Acceptance: exercise the shared execution path and distinct policy boundaries,
including changed executable, extra/reordered arguments, literal metacharacters,
disabled automatic reads, missing per-run grant, and hard-denial precedence.
Prove rule decisions are inspectable and cannot be replayed. Add further rules
only when a concrete workflow and behavior tests justify them.

### Stage 31e: Scheduled proposals without execution

Keep all scheduled command access disabled through Stages 31a-31d. Then allow an
owner-only task creation option to supply an exact command proposal capability:
executable, argv, and canonical root/cwd. Save the validated capability with the
task definition and occurrence snapshot using Phase 24's revision rules. Start
with a fixed invocation chosen by the owner; no model-selected executable,
argument template language, or arbitrary scheduled command generation is needed.

An opted-in reporting task may choose to propose that saved invocation once per
occurrence. It can never run it, including commands that would qualify for an
interactive automatic-read rule. Keep monitor tasks ineligible. Reject combined
note/command proposal capabilities initially to retain the existing one-proposal
per-occurrence contract. Task chat tools cannot grant this permission themselves.

Use Phase 27's separate proposal notification, destination authorization,
deduplication, and uncertain-send behavior. Notify with a bounded command summary
and local review ID; do not send environment values or command output. No message
reply, reaction, delivery success, or scheduled model decision can approve it.
Task edits, capability revocation, and task deletion invalidate pending proposals.
Recheck current command policy and task revision at approval. Preserve receipts
when clearing the source task.

Acceptance: ordinary tasks and monitors cannot propose or execute commands;
opted-in tasks can only propose the exact saved invocation once. Cover stale
revisions, revoked permissions, task cleanup, duplicate/uncertain notifications,
and attempted automatic reads. Finish with a disposable live notification and
local approval check before declaring scheduled proposals validated.

### Stage 31f: Optional advisory model review

Only after the deterministic/manual stages are useful, assess whether an
auxiliary reviewer reduces confusing owner prompts. Keep it separately opt-in
and disabled by default. Use the existing provider/model resolver with an
explicit reviewer selection and no silent provider fallback. Do not add another
agent runtime or let the reviewer call tools.

Send only the bounded current owner request, exact structured command, relevant
host policy result, and the declared host-execution limits. Exclude credentials,
unrelated history, project files, and command output. Treat all request/argument
text as untrusted; it cannot supply reviewer instructions or policy. Use a
10-second timeout and a small strict response schema for `low_risk`, `high_risk`,
or `uncertain`, plus a bounded explanation.

The review explains or escalates a pending request. It never grants execution,
changes arguments, bypasses a hard denial, or replaces local owner approval.
Timeout, malformed output, unavailable provider, and suspected injection fall
back to the ordinary manual path. Show advice as model advice, separately from
the deterministic decision and actual authorization authority.

Acceptance: hostile argument/reason text cannot change tool availability or
authorization, and every reviewer failure leaves the same safe manual path.
Use deterministic provider fixtures for these behaviors, then record false
positives, missed risks, latency, and provider usage on a reviewed command set.
Automatic approval by a model requires a separate future plan and evidence;
it is not a hidden mode in this phase.

### Implementation reach and completion gates

| Area                | Required changes                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config              | `packages/config/src/source.ts` and command settings validation, file/environment precedence, disabled defaults, non-executing inspection                           |
| Executor            | A focused command service and process adapter in `packages/agent/src/`, reusing proven subprocess patterns without changing browser/MCP permissions                 |
| Store               | `approval-schema.ts`, `approval-store.ts`, exports and the next required migration; typed command payloads, authorization receipts, note compatibility and recovery |
| Agent               | `conversation.ts`, tool schemas/instructions, run capability provenance, journal/budget integration and selected receipt context                                    |
| CLI and worker      | CLI argument/request schemas, `chat.ts`, `command-args.ts`, `runtime.ts`, approval commands, worker host/transport, explicit capability support detection           |
| Scheduled follow-up | Task schema/store/commands/occurrence snapshots and gateway proposal summaries, retaining note behavior and one proposal per occurrence                             |
| Reviewer follow-up  | Existing model resolver, strict bounded review response and advisory rendering, with no new execution authority                                                     |
| Docs                | Configuration, CLI/chat, owner approvals, storage, architecture, development, task permissions when implemented, and validation records                             |

Older workers must reject command-capable requests explicitly. Add a capability
route/version check using the existing project/approval transport pattern so
unknown optional fields cannot silently drop a requested restriction or grant.
Never fall back to local execution after sending a mutating request. Preserve
existing plain chat, note approvals, MCP allowlists, and scheduled read limits.
Configured MCP executors are independent trusted integrations; this new gate
cannot claim to mediate arbitrary commands run through existing MCP tools.

Run focused behavior tests and `bun run check` at each implementation stage.
Use temporary stores, private disposable directories, and fixture processes.
Migration checks must preserve pending/completed/uncertain note proposals,
payload digests, receipts, and task snapshots; no reset or live database migration
is part of automated validation. Test actual worker/local paths and the pinned
runtime as well as injected model/policy behavior.

Before completing the first delivery, manually grant one disposable directory,
ask for a harmless command, review it, approve once, and inspect its real receipt.
Confirm proposing alone does nothing, repeated approval does nothing, cancellation
prevents dispatch, revocation blocks a pending request, and a new chat message
does not inherit permission. Check a timeout with a partial local effect and
inspect uncertainty before preparing any replacement. Reserve separate live
checks for automatic reads, scheduled delivery, and the advisory reviewer.

Record source/fixture, pinned-runtime, real-model, and live-messaging evidence
separately. Passing command fixtures does not prove safe arbitrary code execution,
OS isolation, or reliable model risk judgments. Implementation and live checks
remain separate validation layers; see the validation record below.

### Validation record

`bun run check` passed on 2026-10-22: formatting, lint, workspace type checks,
and 985 tests across 70 files. Command coverage includes real fixture processes,
the pinned macOS process-group probe, local and worker CLI paths, lost worker
responses, exact source/payload binding, grant expiry between runs, argument/path
and preview limits, cancellation, executable replacement, uncertainty/restart,
and preservation of authorization after a failed completion receipt.

Automatic-read tests distinguish rule authority from owner approval. Scheduled
tests prove fixed capabilities cannot execute automatic reads, stale task
permissions invalidate proposals, and separate notices preserve deduplication
and uncertain-send behavior. Advisory review fixtures have no tools or execution
authority and malformed advice leaves manual approval. Migration checks preserve
existing note payload bytes/receipts and roll back the new schema atomically.

The test preload still isolates HOME, environment and network for both process
APIs through the pinned Bun implementation. The owner's live configuration and
database were not changed. Linux CI, real-model command preparation, a live
scheduled notice, and reviewer usefulness/cost remain separate manual or remote
checks. See [command validation](commands.md#validation).

### Design references

Reviewed on 2026-10-22. Hermes' built-in
[command approval](https://github.com/NousResearch/hermes-agent/blob/main/tools/approval.py)
and [smart reviewer](https://github.com/NousResearch/hermes-agent/blob/main/tools/approval_smart.py)
inform the rules/reviewer/owner split. Poppet's first reviewer stage stays advisory.
[Bun's process documentation](https://bun.sh/docs/runtime/child-process) describes
argv-based spawning and process controls; verify each required API against the
pinned runtime rather than assuming the latest documentation proves compatibility.

## Validation

Use behavior tests with injected model resolvers and auth layers and a controllable clock.
Run shared text and tool-exchange cases against each provider adapter, including
stream completion, cancellation, and continuation preservation.
Exercise persistence against temporary SQLite databases. Keep live account checks
focused on subscription access, token renewal, one tool round trip, and the
completed assistant flow. Do not claim these live checks passed from fake-provider
tests.
