# Poppet implementation plan

[Documentation index](index.md)

Phases 1–21 and 23–26 are implemented with automated checks. Live validation
remains outstanding where listed below.
Phases 27–30 are planned only. Plans do not authorize implementation.

Completed phases retain short status summaries, evidence, and outstanding checks.
Use the linked guides for current behavior and setup. Git history retains the
original delivery plans.

The remaining priority order is reviewed actions, browser login state, doctor,
then calendar briefing and weekly review trials using existing tools. Independent
work such as doctor need not wait for earlier phases.

Updated: 2026-10-22

Storage history: the unreleased base schema was consolidated into version 1.
Phases 23–26 add migrations 2–5 for monitoring, task controls, attachments, and
projects while retaining earlier data. Historical validation records describe
checks performed at delivery time, not checks rerun for this documentation update.
See [storage](storage.md#schema-and-saved-records),
[development](development.md#store-migrations), and
[architecture](architecture.md) for current contracts and dependency boundaries.

## Phase 1: Foundation and subscription verification

Implemented the CLI foundation, pinned tooling, CI, protected ChatGPT sign-in,
PKCE and identity validation, credential refresh, and subscription verification.
Live subscription inference and a local tool round trip passed on 2026-10-13.
Automated checks cover auth failures, protected storage, refresh rotation,
competing owners, cleanup, and incomplete streams.

Remaining live check: token renewal across restart. See the
[ChatGPT guide](providers/openai-chatgpt.md) and [development](development.md).

## Phase 2: Provider interface and configured model

Implemented the shared provider contract, configured model selection, and
ChatGPT, OpenCode Go, and OpenRouter adapters. Automated checks cover text/tool
exchanges, continuation, streaming failures, cancellation, deadlines, and selected
provider composition. No automatic inference retries or model fallbacks are enabled.
OpenCode Go rejects assistant workloads before credential access.

Remaining live checks: Go and OpenRouter inference and a fresh ChatGPT exchange
through the shared contract. Public Go/OpenRouter catalogs were checked on
2026-10-13; that does not establish live inference. See the
[provider contract](architecture.md#provider-interface) and [provider guides](index.md#providers).

## Phase 3: Durable credentials and storage

Implemented protected credentials and owner-only SQLite storage, atomic
migrations, durable sessions/messages/runs, provider continuation, and exclusive
store ownership. Automated checks cover reopening, migration/write rollback,
invalid records, competing owners, and interrupted-run recovery without replay.

Live credential refresh across restart remains outstanding. Unknown legacy owner
locks require inspection before removal; dead-process recovery is implemented in
Phase 8. See [storage](storage.md) and the [ChatGPT guide](providers/openai-chatgpt.md).

## Phase 4: Persisted chat

Implemented persisted one-shot and interactive chat, streamed answers, bounded
whole-exchange context, fixed provider/model/workload selection, cancellation,
and a five-minute absolute deadline. Failed or partial answers remain inspectable
without becoming successful context; requests are never automatically replayed.
Automated checks cover restart/resume, continuation, context limits, provider
failures, CLI/worker parity, and terminal input through a fake-provider PTY check.

Remaining live check: multi-turn chat, restart/resume, and failure/cancellation
inspection against a real account. See [chat](chat.md).

## Phase 5: Tools and notes

Implemented the sequential tool loop and bounded note read/search/save tools.
Whole batches are validated before execution. Notes stay within the configured
root with symlink/hard-link rejection and atomic writes. Durable call records
retain uncertain outcomes without replaying a possibly completed write.
Automated checks cover filesystem boundaries, budgets, cancellation, recovery,
and persistence failures after a successful write.

Remaining live check: find and read notes, save a summary, and resume the chat
using a real provider. See [notes](notes.md) and [chat](chat.md).

## Phase 6: Explicit memory

Implemented explicit keyed facts, editable profile context, CLI management, and
model-requested remember/replace/forget through the shared memory service.
Facts change only on the owner's current request; retrieved text grants no
mutation authority. Scheduled runs cannot write memory or notes. Automated checks
cover limits, fixed per-run snapshots, provenance, restart, local/worker parity,
cancellation, and uncertain outcomes without replay.

Remaining live check: save a preference, use it in a fresh session, replace it,
and forget it across restarts, including model intent handling. See
[memory](memory.md#ask-the-model-to-change-a-fact).

## Phase 7: Durable scheduled tasks

Implemented one-off and timezone-aware recurring tasks, durable occurrences,
provider holds, explicit retries, and protected worker communication. Scheduling
and enqueue commit together. Missed recurring slots are skipped; overdue one-offs
run once. At most one occurrence per task is pending/running. Recurring pending
work expires after 24 hours; one-offs do not expire. Crashed active runs require
explicit retry and uncertain effects are never replayed automatically.
Automated checks cover scheduling, DST, recovery, provider holds, and concurrent clients.

Remaining live check: schedule a notes summary, inspect it, pause/resume, and
restart around a due time without duplicate work, including quota recovery.
See [scheduled tasks](tasks.md).

## Phase 8: Unattended operation

Implemented macOS LaunchAgent install/start/stop/status/logs/uninstall, scoped
shutdown, bounded rotating logs, provider/task inspection, and dead-process owner
recovery. Saved startup configuration excludes API keys. Existing LaunchAgents
may need reinstalling to adopt the current launcher and worker mode. Unknown
legacy PID markers still require manual inspection. Automated checks use injected
launchctl operations, process-crash recovery, and simulated clock jumps.

Remaining manual checks: native login startup, actual sleep/wake, and an unattended
live daily summary with inspectable results or failures. See [worker](worker.md).

## Phase 9: Interactive use with the worker running

Implemented chat, memory, session/task inspection, and store status through one
protected worker socket and shared agent permit, with streaming and cancellation.
Only an absent/refused socket permits local fallback; lost, incomplete, malformed,
or old-worker replies never replay a delivered command. Automated socket checks
cover queued chat/scheduling, cancellation, shutdown, limits, and safe fallback.

Remaining live check: leave the worker running, chat, change memory, inspect
sessions/results, and cancel a request without stopping the worker.
See [worker](worker.md) and [chat](chat.md).

## Phase 10: Messaging gateway with Discord thread sessions

Implemented owner-restricted Discord thread chat, durable inbox/run bindings,
ordered saved-answer delivery, cancellation/status controls, and bounded gateway
queues. Accepted inputs survive restart; pre-acceptance Discord events may require
resending. Delivery retries use saved answers, with uncertain sends retained for
inspection. Channel registrations and worker modes isolate adapter failures while
sharing one store and agent. Automated checks cover authorization, duplicates,
ordering, reconnection, restart, delivery failure, mode selection, and cleanup.

Remaining live checks: bot setup, intent/permission failures, thread visibility,
mentions and follow-ups, independent thread history, renamed/archived threads,
restart, cancellation, and reconnect in a private channel. Native service startup
also remains manual. See [Discord](gateways/discord.md).

## Phase 11: Scheduled results in messaging conversations

Implemented explicit scheduled-result destinations and delivery through the
existing gateway queue. Occurrences snapshot destinations; delivery rechecks
access and never reruns inference because sending failed. Execution and delivery
states remain separate. Automated checks cover destination resolution, recovery,
revoked/deleted threads, rate limits, uncertain sends, and local-only tasks.

Remaining live check: deliver one scheduled result to an authorized private
Discord thread, including restart/retry without changing destination or repeating
inference. See [scheduled tasks](tasks.md) and [Discord](gateways/discord.md).

## Phase 12: Additional messaging adapters

Implemented owner-only private Telegram chat and QR-linked personal-account
WhatsApp, including scheduled destinations and separate protected credentials.
Telegram checkpoints updates after durable acceptance/rejection. WhatsApp uses an
unofficial pinned client, with account-restriction and protocol-compatibility
risks; its pre-acceptance receive buffer cannot guarantee crash recovery.
Automated checks cover authorization, cursor/key persistence, deduplication,
restart, isolation, cancellation, bounded queues, delivery, and setup redaction.
The WhatsApp Bun imports/crypto/auth/protobuf/QR smoke check passed.

Remaining live checks for each adapter: setup/pairing, owner chat, rejection of
other senders, restart/resume, cancellation, and scheduled delivery without
repeating execution. WhatsApp protocol compatibility and phone delivery remain
unverified. See [Telegram](gateways/telegram.md) and
[WhatsApp manual validation](gateways/whatsapp.md#manual-validation).

## Phase 13: Search past conversations

Implemented CLI and model conversation search over completed user/final-assistant
messages using SQLite FTS5. Results are bounded and cite session/message IDs;
failed runs, tools, reasoning, and continuation are excluded. Historical text
cannot authorize current actions. Automated checks cover indexing/backfill,
rollback, restart, Unicode queries, ordering, limits, local/worker parity, and
injected-model scheduled reads.

Remaining live check: find an older discussion with search, inspect the session,
and ask a new real-model chat to recall it. See [chat](chat.md).

## Phase 14: Explicit local Markdown skills

Implemented explicitly selected local Markdown skills, validated bounded files,
CLI inspection, and durable session/task instruction snapshots. Messaging supports
explicit skill selection on a new session. Source edits/deletion do not change
saved snapshots, and skills cannot expand tool permissions. Automated checks cover
filesystem boundaries, restart, local/worker/gateway selection, task inheritance,
context budgets, and scheduled read-only policy.

Remaining live checks: one skill-assisted chat and scheduled run, snapshot behavior
after editing the source, an unselected chat, and explicit messaging selection.
See [skills](skills.md).

## Phase 15: Read a supplied URL

Implemented bounded public HTTP(S) page reading for URLs authorized by the current
request or task prompt. DNS/public-address checks, literal-IP connections, TLS
identity, redirects, decompression limits, and cancellation enforce the boundary.
History, skills, notes, and page links cannot grant access. Automated checks cover
SSRF/rebinding, production transport isolation, extraction, limits, failures, and
scheduled reads. Live HTML and UTF-8 text retrieval passed on 2026-10-16.

Remaining live checks: model-assisted HTML/text summaries and a scheduled fetch.
See [supplied URLs](chat.md#read-a-supplied-url) and
[page-reading configuration](configuration.md#page-reading).

## Phase 16: Session titles and Discord thread names

Implemented immediate fallback session titles, one bounded automatic naming
attempt, manual rename, and managed Discord thread names. Stable IDs remain the
identity; naming failure keeps the fallback and cannot fail the main chat.
Automated checks cover sanitization, restart/attempt claiming, saved-title races,
manual rename precedence, and thread synchronization.

Remaining live checks: title inference and private-channel Discord creation,
renaming, and manual-edit races, including the platform's non-atomic rename race.
See [chat](chat.md) and [Discord](gateways/discord.md).

## Phase 17: Web search

Implemented opt-in Brave web search, independent protected credentials, bounded
results, and run-local page grants for successfully journaled result URLs.
Snippets, omitted URLs, previous runs, and fetched links grant no access. Scheduled
search retains read-only mutation policy. Automated checks cover credential
isolation/redaction, result limits, cancellation, failures, search-to-page dispatch,
and unchanged page-reader protections.

Remaining live checks: one research chat and a scheduled research summary delivered
through messaging, with source citations. See
[web-search configuration](configuration.md#web-search).

## Phase 18: Task management through chat

Implemented chat task creation, bounded inspection, pause, and resume through the
existing scheduler. Only the owner's current request authorizes mutation; the
host fixes identity, inference selection, and any current-conversation destination.
Scheduled runs cannot call task management. Task changes and durable tool receipts
commit together, with duplicate-call recovery and no automatic replay.
Automated checks cover authority, schedules, destinations, rollback, restart,
cancellation, worker parity, and shared-agent deadlock avoidance. Phase 24 adds
editing and execution controls.

Remaining live checks: create, inspect, pause/resume, and deliver one occurrence
through real-model chat. See [chat task management](tasks.md#manage-tasks-through-chat).

## Phase 19: Deeper conversation recall

Implemented bounded conversation reads around search matches or by stable cursor.
Only completed user/final-assistant text is returned; reading does not resume the
source session, import continuation, or mutate memory. Historical text and URLs
grant no new authority. Automated checks cover eligibility, anchors, chronological
paging, byte/Unicode limits, durable calls, cancellation, and scheduled restrictions.

Remaining live check: search for an older decision, read its surrounding discussion,
and answer a follow-up with a real model using saved context. See
[conversation context](chat.md#read-conversation-context).

## Phase 20: MCP server support

Implemented explicitly configured local stdio MCP servers, bounded discovery,
original-schema validation, separate interactive/scheduled allowlists, inspection,
and owner-scoped subprocess cleanup. Servers run with the host account's permissions;
allowlists are not an OS sandbox. Untrusted results grant no built-in mutation or
page access. Dispatched uncertain calls are recorded without automatic replay.
Fixture-server and injected-model checks cover protocol lifecycle, permissions,
secret isolation, limits, cancellation, errors, and durable outcomes.

Remaining live checks: inspect a trusted server's allowed tools, complete a real-model
CLI and messaging tool round trip, verify an explicitly allowed scheduled read,
and stop the worker without orphaned servers. Remote transports and broader MCP
capabilities remain outside this phase. See [MCP tools](mcp.md).

## Phase 21: Browser automation with agent-browser

Implemented optional interactive-only browser automation using a fixed adapter
and fresh run-owned native daemon/browser. Fixture and injected-model checks passed,
plus a standalone local-browser check with agent-browser 0.39.1 and Chrome for
Testing 155.0.8059.84 on Apple silicon macOS. Scheduled runs receive no browser tools.

Domain policy remains explicit: exact hostnames restrict requests; `"*"` permits all
HTTP(S) hosts, including private networks, while retaining WebRTC blocking.
Browser traffic does not use the page reader's DNS/IP protections, and a hostname
allowlist is not an OS network sandbox. Actions require the owner's current request;
page content grants no authority. Uncertain interactions are never replayed.
Persistent login state remains planned in Phase 28.

Remaining live completion gate: use a real model through CLI and authorized
messaging for extraction and an intentional form action on a disposable site.
Inspect saved calls, verify denied navigation, cancel a running workflow, and
confirm no run-owned daemon/browser remains after cancellation or worker shutdown.
These checks must pass before describing browser support as complete. See
[browser automation](browser.md).

## Phase 23: Change-aware monitoring

Implemented optional change-aware recurring monitoring through the existing task
worker and read-only sources. The host compares fresh, validated evidence with the
last successful value: the first observation establishes a quiet baseline,
unchanged values stay quiet, and changes enqueue one notification. Failures preserve
the baseline; recovery never repeats inference or uncertain delivery. Automated
checks cover evidence validation, baseline decisions, crash recovery, cancellation,
permissions, queue progress, migrations, and CLI/worker/chat creation.

Recorded validation on 2026-10-21 passed formatting, lint, types, and 900 tests
across 64 files using isolated state. No live provider or messaging validation
was performed. See [monitoring](tasks.md).

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

Implemented Stages 24a–24d: task editing, skip-next, snoozing, and run-now through
CLI and chat. Definition revisions and occurrence snapshots preserve history and
reject stale targets. Snoozing persists ready time without shifting cron cadence;
run-now uses ordinary permissions and provider holds. Prompt-edited monitors start
a fresh quiet baseline. Automated checks cover races, atomic receipts, migration
preservation, restart, exact-slot controls, timing/expiration, and scheduled denial.
See [task controls](tasks.md#edit-and-control-the-next-execution).

Remaining manual checks: use disposable local state for a short CLI and worker-backed
manual path. Edit a saved task and inspect its identity/history; skip one slot;
snooze one check, restart before it is due, and verify it runs once afterward.
For monitoring, edit the source prompt and confirm a new quiet baseline. Request run-now and confirm the next cron time stays intact.
Separately exercise the implemented chat actions with a real model and one
authorized messaging destination, checking receipts and eventual delivery.

Passing fixtures or planning this phase does not establish real-model intent
handling, physical sleep/wake behavior, or live messaging reliability. Record
implemented stages, automated validation, and manual evidence separately.

## Phase 25: Documents and voice messages

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

Remaining manual path: in an authorized Telegram chat, send a text file, a short
PDF, an unsupported file, and, after enabling voice, a short recording. Check
restart/deduplication, answer grounding, and a dictated reminder's subsequent text
confirmation. Raw bytes are removed after processing; saved transcripts, answers,
and provider-side records remain subject to their own retention. See
[Telegram manual validation](gateways/telegram.md#manual-validation).

## Phase 26: Context for individual projects

Implemented Stages 26a–26c: explicitly selected project instructions saved with
sessions/tasks, scoped facts and recall, and selected notes. Projects cannot grant
additional tools or filesystem access. Automated checks cover CLI/worker/gateway
selection, task inheritance/retry, file boundaries, snapshots, scoped access,
context limits, stale workers, and migration rollback. See [projects](projects.md).

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

Remaining manual path: create two projects with conflicting harmless preferences,
continue each after restart, and schedule a review. Confirm inspection shows the
selection and unrelated facts/notes are excluded. Repeat explicit selection in an
authorized messaging conversation; assess real-model instruction-following and
review quality separately from injected-model prompt assertions.

## Phase 27: Actions the owner can review and approve

Planned only. Start with one concrete action: creating a new note inside the
existing notes root. Reuse note validation, protected worker ownership, durable
tool-call provenance, and existing inspection patterns. Broaden to one external
integration only after the local approval lifecycle is proven.

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

Proposed local owner commands:

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

## Validation

Use behavior tests with injected model resolvers and auth layers and a controllable clock.
Run shared text and tool-exchange cases against each provider adapter, including
stream completion, cancellation, and continuation preservation.
Exercise persistence against temporary SQLite databases. Keep live account checks
focused on subscription access, token renewal, one tool round trip, and the
completed assistant flow. Do not claim these live checks passed from fake-provider
tests.
