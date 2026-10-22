# Future priorities

[Documentation index](index.md) · [Implementation plan](implementation-plan.md)

Recorded on 2026-10-21. These priorities have detailed plans in the
[implementation plan](implementation-plan.md), in the order discussed. They are
not scheduled work or authorization to implement them. Recheck current
capabilities and the relevant phase's compatibility gates before implementation.

Change-aware monitoring already has a [Phase 23 plan](implementation-plan.md#phase-23-change-aware-monitoring).
Task controls are implemented in Phase 24, and Telegram documents/local voice in
Phase 25. Project context is implemented in Phase 26. Local and scheduled note
approvals are implemented in Phase 27; external actions remain gated. Command
execution is implemented in Phase 31. Browser login state, doctor and the
workflow trials remain planned work.

## 1. Editable tasks and snoozing

Implemented with automated checks in [Phase 24](implementation-plan.md#phase-24-editable-tasks-and-snoozing),
including editing, skip-next, snooze, and run-now. See the [task controls guide](tasks.md#edit-and-control-the-next-execution).

Support requests such as "Move my morning summary to 08:30", "Skip tomorrow",
and "Run this now" without recreating a task.

Task IDs and history are preserved. Revisions and exact execution targets reject
stale changes; occurrence snapshots preserve historical definitions. Live model
and messaging validation remain manual.

Starting points: [scheduled tasks](tasks.md), `packages/tasks/src/task-schema.ts`,
`task-store.ts`, `commands.ts`, `chat-tools.ts`, and `apps/cli/src/tasks.ts`.

## 2. Documents and voice messages

Implemented in [Phase 25](implementation-plan.md#phase-25-documents-and-voice-messages):
authorized Telegram text/PDF attachments and opt-in local voice transcription.
See [Telegram usage](gateways/telegram.md#documents-and-voice) and the
[compatibility probe](attachment-probe.md). Live Telegram/model checks remain manual.

The owner can send a document for summarization or dictate a reminder proposal.
Extracted text stays untrusted, temporary raw files are removed, and voice-derived
actions require a subsequent text confirmation. Screenshots and scanned-document
OCR remain outside this phase.

Starting points: [Telegram](gateways/telegram.md), [gateway architecture](architecture.md#messaging-gateway),
`packages/gateway/src/channel.ts`, and `packages/channel-telegram/src/`.

## 3. Context for individual projects

Implemented in [Phase 26](implementation-plan.md#phase-26-context-for-individual-projects),
including saved instructions, scoped facts and recall, and selected notes. See
[project context](projects.md) for setup and the remaining live manual checks.

Let the owner explicitly select a project with its own instructions, selected
notes, and facts. Project details should load for that project without becoming
global memory for unrelated conversations.

Selection persists in sessions and scheduled tasks; project preferences refine
compatible global preferences. Selected notes retain normal file checks and
permissions. Automatic project detection and a project-management interface
remain outside this phase.

Starting points: [memory](memory.md), [skills](skills.md),
`packages/agent/src/context.ts`, and the saved session/task snapshots.

## 4. Actions the owner can review and approve

Local note proposals and explicitly enabled scheduled proposals are implemented
in [Phase 27](implementation-plan.md#phase-27-actions-the-owner-can-review-and-approve).
See [owner approvals](approvals.md) for setup, recovery and remaining live checks.
The owner chose to keep external actions gated after Apple Notes failed its
destination-identity compatibility gate.

Let Poppet prepare a concrete change, show the proposed action, and wait for
approval before executing it. A scheduled review could propose a calendar
change or draft a reply only after a future external adapter passes its gate.
Scheduled note reviews can prepare a proposal now, while execution waits for
local owner approval.

Local approvals bind an immutable create-only note payload to its owner, source,
expiry and destination, with one dispatch and durable uncertainty. Scheduled
permission only prepares a proposal; execution still needs explicit local approval.
External adapters require separate compatibility evidence.

Starting points: [MCP permissions](mcp.md#permissions-and-untrusted-content),
[browser permissions](browser.md#permissions-and-limits), and the durable tool journal.

## 5. Browser login state across requests

Planning is captured in [Phase 28](implementation-plan.md#phase-28-browser-login-state-across-requests),
with a pinned-runtime compatibility gate, exclusive profile ownership, attended
login, explicit CLI session selection, and clearing/recovery.

Allow an explicitly enabled, isolated browser profile to retain login state
between messages so authenticated workflows do not require signing in every time.

Start with one owner-managed profile. Plan protected storage, exclusive process
ownership, lifecycle and cleanup, revocation, and how the owner inspects or clears
saved state. Keep normal browser use isolated by default. This does not imply
scheduled browser access or access to the owner's everyday browser profile.

Starting points: [browser lifecycle](browser.md#use-and-lifecycle),
`packages/browser/src/browser.ts`, and `browser-process.ts`.

## 6. A useful `poppet doctor`

Planning is captured in [Phase 29](implementation-plan.md#phase-29-a-useful-poppet-doctor),
with local inspection, bounded worker observations, and consistent human/JSON
results. It can be delivered independently of the other planned phases.

Provide one command that explains worker availability, authentication problems,
provider pauses, failed scheduled work or delivery, and unavailable MCP/browser
tools, with a concrete next step for each problem.

Start by combining existing inspection results. Keep default checks read-only;
do not launch tools, make paid model requests, restart services, or repair state
implicitly. Distinguish saved status from a live connectivity check, and keep
credentials and private content out of diagnostic output.

Starting points: [worker status](worker.md#status-and-logs),
[CLI inspection commands](cli.md), and the existing task, auth, MCP, and config status paths.

## 7. Command execution and approval

Implemented with automated checks in [Phase 31](implementation-plan.md#phase-31-command-execution-and-approval).
Opt-in CLI commands use structured arguments, an explicit per-run working-directory
grant, exact one-time owner approval, bounded process lifetime/output, and durable
receipts. See [command execution](commands.md) for configuration and remaining live checks.

Separate opt-ins cover narrowly defined automatic reads, fixed scheduled
command proposals without execution, and optional advisory model review. Model
review cannot approve commands. External action adapters remain gated, and command
approval does not provide OS isolation or permission to run untrusted code.

Starting points: [owner approvals](approvals.md), `packages/agent/src/approvals.ts`,
`packages/store/src/approval-schema.ts`, `approval-store.ts`, and the existing
browser/MCP subprocess lifecycle code. Commands remain disabled by default.

## Workflows to try with existing tools

Trial stages are captured in [Phase 30](implementation-plan.md#phase-30-calendar-briefings-and-weekly-reviews),
covering capability/time-source checks, a calendar briefing, and a weekly review.
These are configuration trials before any dedicated runtime integration.

Try calendar briefings and weekly project reviews with existing MCP reads,
scheduled tasks, and local skills before planning dedicated integrations.
Record any missing capability discovered during those trials. They may need only
configuration and a reusable procedure.
