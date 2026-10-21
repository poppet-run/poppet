# Future priorities

[Documentation index](index.md) · [Implementation plan](implementation-plan.md)

Recorded on 2026-10-21. These are candidates for later planning, in the order
discussed. They are not scheduled work or authorization to implement them.
Recheck current capabilities before starting a separate plan for any item.

Change-aware monitoring already has a [Phase 23 plan](implementation-plan.md#phase-23-change-aware-monitoring).
The remaining priorities are below. Task editing is the suggested next focused
improvement.

## 1. Editable tasks and snoozing

Support requests such as "Move my morning summary to 08:30", "Skip tomorrow",
and "Run this now" without recreating a task.

Start by planning schedule and prompt edits through the existing task commands
and chat tool. Preserve task identity and history, validate timezone changes,
and define what happens to pending and active occurrences. Treat skip-next,
snooze, and run-now as distinct follow-ups rather than adding them all at once.

Starting points: [scheduled tasks](tasks.md), `packages/tasks/src/task-schema.ts`,
`task-store.ts`, `commands.ts`, `chat-tools.ts`, and `apps/cli/src/tasks.ts`.

## 2. Documents and voice messages

Let the owner send a document for summarization or dictate a reminder from a
phone. Start with text attachments and text-based PDFs in one messaging adapter.
Plan voice transcription afterward; screenshots and scanned-document OCR can wait.

Define bounded downloads, file-type validation, temporary-file cleanup, saved
content retention, and how extracted text reaches the existing agent. Extracted
document text stays untrusted. Voice transcription needs an explicit service or
local-runtime choice and a decision about where audio is sent and retained.

Starting points: [Telegram](gateways/telegram.md), [gateway architecture](architecture.md#messaging-gateway),
`packages/gateway/src/channel.ts`, and `packages/channel-telegram/src/`.

## 3. Context for individual projects

Let the owner explicitly select a project with its own instructions, selected
notes, and facts. Project details should load for that project without becoming
global memory for unrelated conversations.

Start with one selected project folder and a small, documented context file.
Plan how selection persists in sessions and scheduled tasks, how project and
global preferences combine, and which files may be read. Selection must not
silently grant broader file or tool access. Automatic project detection and a
project-management interface can wait.

Starting points: [memory](memory.md), [skills](skills.md),
`packages/agent/src/context.ts`, and the saved session/task snapshots.

## 4. Actions the owner can review and approve

Let Poppet prepare a concrete change, show the proposed action, and wait for
approval before executing it. A scheduled review could propose a calendar
change or draft a reply while execution waits for the owner.

Start with one action type through an existing integration. Bind approval to
the exact tool, arguments, owner, and destination, with expiry and duplicate
execution protection. Define cancellation, changed external state, and uncertain
outcomes. Keep scheduled execution permissions unchanged until that workflow has
its own design and validation. Avoid a general workflow engine.

Starting points: [MCP permissions](mcp.md#permissions-and-untrusted-content),
[browser permissions](browser.md#permissions-and-limits), and the durable tool journal.

## 5. Browser login state across requests

Allow an explicitly enabled, isolated browser profile to retain login state
between messages so authenticated workflows do not require signing in every time.

Start with one owner-managed profile. Plan protected storage, exclusive process
ownership, lifecycle and cleanup, revocation, and how the owner inspects or clears
saved state. Keep normal browser use isolated by default. This does not imply
scheduled browser access or access to the owner's everyday browser profile.

Starting points: [browser lifecycle](browser.md#use-and-lifecycle),
`packages/browser/src/browser.ts`, and `browser-process.ts`.

## 6. A useful `poppet doctor`

Provide one command that explains worker availability, authentication problems,
provider pauses, failed scheduled work or delivery, and unavailable MCP/browser
tools, with a concrete next step for each problem.

Start by combining existing inspection results. Keep default checks read-only;
do not launch tools, make paid model requests, restart services, or repair state
implicitly. Distinguish saved status from a live connectivity check, and keep
credentials and private content out of diagnostic output.

Starting points: [worker status](worker.md#status-and-logs),
[CLI inspection commands](cli.md), and the existing task, auth, MCP, and config status paths.

## Workflows to try with existing tools

Try calendar briefings and weekly project reviews with existing MCP reads,
scheduled tasks, and local skills before planning dedicated integrations.
Record any missing capability discovered during those trials. They may need only
configuration and a reusable procedure.
