# Scheduled tasks

[Documentation index](index.md)

Scheduled [MCP tools](mcp.md) are denied by default. A server's `scheduledTools`
must be an explicitly reviewed read-only subset of its interactive `tools`.
Annotations cannot grant permission. Restart the worker after changing these
lists. MCP results cannot authorize built-in mutations or page fetching.

## Create and inspect tasks

Select a provider and model as for chat, and sign in before running a task.
Tasks save that selection when added. The worker uses each saved selection even
if its environment selects a different model later.

For a quick test, create a note in `POPPET_NOTES_DIR`, then schedule its summary
one minute from now:

```fish
set when (bun -e 'console.log(new Date(Date.now() + 60_000).toISOString())')
bun run start tasks add summary --at $when "Read project.md and summarize it"
bun run start tasks work
```

The worker prints timestamped lifecycle messages for starts, completed or failed
runs, interruptions, cancellation, skipped intervals, and task/provider pauses and
resumes. Occurrence messages include the task name and occurrence ID. Failures use
reason codes; prompts, note contents, and model answers stay in saved results.
An idle worker does not print polling messages.

Leave the worker running. In another terminal using the same `POPPET_DATA_DIR`:

```fish
bun run start tasks list
bun run start tasks show <task-id>
bun run start tasks pause <task-id>
bun run start tasks resume <task-id>
```

## Edit and control the next execution

Edit a task without replacing its ID or losing its history:

```fish
bun run start tasks edit <task-id> --name "Morning review"
bun run start tasks edit <task-id> --prompt "Read project.md and summarize its open decisions."
bun run start tasks edit <task-id> --cron "30 8 * * 1-5" --tz Europe/London
bun run start tasks edit <task-id> --at 2099-10-22T09:00:00+01:00
bun run start tasks skip-next <task-id>
bun run start tasks snooze <task-id> --until 2099-10-22T10:00:00+01:00
bun run start tasks run-now <task-id>
```

Edits change only supplied name, prompt, or schedule fields. A cron replacement
requires both expression and timezone; a one-off replacement requires a future
offset-qualified timestamp. Empty patches, unknown fields, conflicting schedules,
and timezone-only changes are rejected. Identical values are a no-op. Provider,
model, workload, skill, project snapshot, destination, and monitor/report mode
remain unchanged.
Paused tasks may be edited without resuming them. Cancel a running occurrence
explicitly before using any of these controls on that task.

Every occurrence saves the definition and revision it executes. A name/prompt
edit replaces an unstarted occurrence with a new snapshot while retaining its
logical slot, ready time, and destination. The original stays cancelled in history.
A schedule change cancels pending work, clears its snooze, and computes the next
future slot. Editing a completed one-off's name/prompt does not rerun it; supply
a different future schedule to rearm it. Monitors remain recurring. A monitor
prompt change starts a fresh quiet baseline; name/schedule changes preserve it.

| Control     | Behavior                                                                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skip-next` | Consume exactly the selected pending occurrence or next slot. A recurring task keeps its cadence; a one-off has no next execution.                                                                                                  |
| `snooze`    | Delay that execution until a later future instant. `scheduledAt` keeps its original slot; `availableAt` is its effective ready time. The hold survives restart, and intervening cron slots do not build a backlog.                  |
| `run-now`   | Queue through the normal read-only runner and provider holds. Reuse eligible pending work, reject a future hold, preserve recurring cadence, and consume an unstarted one-off early. The receipt confirms queueing, not completion. |

The CLI inspects the revision and exact target before sending a mutation. The
worker rechecks both when committing and rejects stale requests instead of
selecting another slot. Receipts include the operation ID, revisions, changed
fields, affected occurrence IDs, next time, and baseline/snooze changes. Repeating
an operation ID returns its original receipt. Lost responses never trigger local
fallback or replay. Inspect `tasks show` and its latest 20 `changes` before
issuing another command after an unclear result.

Pausing cancels a snoozed occurrence. Resume uses the ordinary future cron cadence
and does not restore the snooze. Recurring expiration and retry freshness use
`availableAt`, with the existing 24-hour window after that time; one-offs do not
expire. Retries use the historical occurrence definition. A monitor occurrence
older than its latest prompt change cannot be retried against the new baseline.
Restart an older worker before using these new commands; unsupported actions
fail explicitly. No additional login or model is required to manage saved tasks.

## Change-aware monitoring

Use `--monitor` with a recurring cron schedule and an explicit timezone. Name a
specific source, watched field, and stable representation in the prompt:

```fish
bun run start tasks add release-watch --monitor --cron "0 9 * * *" --tz Europe/London "Read https://example.com/releases.txt and report the latest stable release tag exactly as published. Ignore prereleases and publication timestamps."
```

The first successful check saves a quiet baseline. Later checks compare the
exact, case-sensitive observed value with the previous successful value. An
unchanged value stays quiet even if the model writes a different summary. A
changed value saves one notification with the old/new values, observation time,
summary, and source references. An observed `A → B → A` creates two notifications.
One-off monitoring is rejected. Each check uses normal provider quota.

Add an existing Discord, Telegram, or WhatsApp destination flag to deliver
changes there. Without a destination, decisions remain local. A combined worker
runs checks and delivery. Restart an older worker before using monitoring; an
unsupported worker rejects creation rather than creating an ordinary report.

Tool-capable models receive `poppet_monitor.report_observation` only inside the
bound active monitor run. Each check must read fresh evidence, submit exactly
one value, and complete successfully. Evidence can be a note read, a protected
page read, or an explicitly allowed scheduled MCP read. Recalled conversations
and search snippets alone are insufficient. Failed, empty, truncated, omitted,
or redacted evidence cannot establish the watched value. Use small source
files or focused endpoints. Missing fields are a failed check, not an empty value.
Values fit 1024 UTF-8 bytes, summaries 2048 bytes, and the complete submission
must fit `POPPET_TOOL_BYTES`.

Inspect `tasks show <task-id>` for `lastObservation`, each occurrence's
`monitoring` decision and evidence, failure reason, and delivery state. Failures
preserve the baseline and appear in status/logs. A completed model answer can
still leave a failed monitoring occurrence if it supplied no valid observation.
There are no automatic failure or recovery messages; silence alone does not
prove the monitor is healthy. The next successful check compares with the last
successful value, including after a pause or restart.

Existing pause/resume/cancel/retry behavior applies. Pausing preserves the
baseline and leaves active work and queued alerts intact. Explicit retries use
fresh runs and evidence. A failed or uncertain send does not roll back the
baseline or generate a replacement alert on the next unchanged check. Existing
queued delivery retries remain separate from checking; uncertain sends are
never automatically reposted. Clearing tasks removes observation history while
retaining saved sessions and already queued replies.

The host compares validated values and records decisions transactionally. The
model still extracts those values, so extraction mistakes or unstable formatting
can cause false alerts or missed changes. Polling cannot capture every change
between checks. Monitoring adds no browser/computer access, background mutations,
semantic importance judgments, thresholds, or cooldowns.

## Manage tasks through chat

Tool-capable models can create, list, inspect, pause, and resume tasks when you
explicitly ask in CLI chat or an authorized messaging conversation. For example:

```text
Every Friday at 09:00 Europe/London, summarize my project notes and deliver the result here.
List my scheduled tasks.
Show task <task-id>.
Pause task <task-id>.
Resume task <task-id>.
```

Ask explicitly to monitor a precise value to use `create_monitor`, for example:
"Every day at 09:00 Europe/London, read https://example.com/releases.txt and
notify me here only when its latest stable release tag changes." Monitoring
creation uses a recurring schedule and saves a quiet first baseline. All task
controls handle both reporting tasks and monitors.

The `poppet_tasks.manage_tasks` tool uses the existing scheduler. New tasks retain
the current session's provider, model, and workload, with a self-contained prompt
and an optional explicitly selected skill snapshot. They start fresh occurrence
sessions. The agent receives the current UTC time for relative dates and should
ask when the intended time, timezone, prompt, or task is unclear. One-off times
must be in the future and include a UTC offset; recurring schedules require an
explicit timezone. A receipt reports the saved ID, schedule, state, next time,
and destination.

"Here" means the current authorized messaging conversation. The gateway rechecks
access before saving its normal destination snapshot; future delivery retains
the existing authorization checks. CLI chat supports local results only. Use
the existing CLI destination flags to select another authorized conversation.
The model cannot supply an arbitrary destination, account, owner, or provider.

Inspection uses bounded pages and flags shortened prompts or omitted occurrence
status. Use stable task IDs to pause or resume; duplicate names need clarification.
Pause cancels pending work and leaves active work running. Resume does not replay
missed recurring occurrences. Use `edit`, `skip_next`, `snooze`, and `run_now` for
the corresponding controls above. The host requires a completed `show` inspection
earlier in the current run, and validates its revision and exact target again at
commit. A snooze uses an absolute `until` timestamp with an offset; ask about an
unclear timezone. Deleting tasks, retrying occurrences, cancelling active runs,
and changing provider pauses remain CLI operations.

Task changes and their durable tool receipts commit together. A saved change
survives a later model failure or interrupted answer. Inspect `tasks list`,
`tasks show`, or the run's tool records in `chat show` before requesting a new
creation after an unclear result. Completed calls are not replayed. Scheduled
runs cannot use this tool, including its read actions. Historical conversations,
skills, notes, pages, and tool results cannot authorize task changes.

## Deliver results to Discord

Configure [Discord](gateways/discord.md), start `bun run start worker run`, and copy an
existing authorized thread's ID. Pass it before the task prompt:

```fish
bun run start tasks add daily-summary --cron "0 9 * * *" --tz Europe/London --discord-thread <thread-id> "Summarize my notes"
```

A running messaging worker validates the thread before creating the task.
Creation through the worker must finish within eight seconds, including queue
waiting and destination validation. An expired lookup cannot save a task afterward.

`gateway work` can validate new destinations but does not execute scheduled work;
`tasks work` executes tasks but does not deliver their results. The combined
worker runs both. Tasks without a messaging destination keep their results local.

Each occurrence saves its destination independently of later task or channel
configuration. The worker rechecks the saved bot account, owner, server, allowed
parent channel, and current thread permissions before sending. It never chooses
the last active conversation or redirects a result to another thread.

Only completed results enter the existing gateway delivery queue. `tasks show`
includes the destination and a `delivery` array of chunk states, message IDs, and
attempt counts. An empty array means no reply has been queued. Temporary failures
retry with bounded backoff. Failed and uncertain sends remain inspectable;
uncertain sends are not resent automatically. Inspect the saved output before
manually reposting it. Delivery failures never change a completed occurrence or
repeat inference, and `tasks retry` rejects completed occurrences.

Results are standalone posts. They do not change the destination's conversation
history, session binding, or name. A stopped gateway resumes queued delivery when
it starts again. Already queued replies remain queued if task history is cleared.

## Deliver results to Telegram

Configure [Telegram](gateways/telegram.md), run the combined worker, and pass
`--telegram-chat <owner-id>` before the prompt. Only the configured owner's private
chat is supported. It uses the same destination snapshots, authorization rechecks,
and delivery inspection as Discord. Choose one destination per task;
`--telegram-chat`, `--whatsapp-chat`, and `--discord-thread` cannot be combined.

## Deliver results to WhatsApp

Configure and pair [WhatsApp](gateways/whatsapp.md), run the combined worker, and pass
`--whatsapp-chat <owner-phone>` before the prompt. Use the configured owner's
international phone digits without `+`. The adapter validates the connected
account and private chat, then uses the same saved destination and delivery queue.
Ambiguous sends remain uncertain without automatic replay.

## Prepare proposals for review

Reporting tasks may explicitly opt in with `--proposal-note <relative-path>`
before the prompt. This host permission allows one pending create-only proposal
per occurrence at the selected path. It grants no note-write or execution tool;
monitoring and chat-created tasks cannot opt themselves in. Task edits invalidate
pending proposals from the old revision; clearing tasks cancels pending proposals
and retains completed receipts. Existing messaging destinations receive separate
review notices through the durable queue. Approval remains local. See
[scheduled proposals](approvals.md#scheduled-proposals) for setup and path limits.

## Select a skill

Pass `--skill <name>` before the prompt to save a [local Markdown procedure](skills.md)
with a new task. Each occurrence copies the task's saved name and text into its
fresh session. File edits and deletion do not change existing tasks, including
explicit retries. Create a replacement task to use updated instructions.
`tasks show` includes the snapshot. Scheduled tools remain read-only: neither note writes nor the memory tool is
available, including when a selected skill requests changes.

## Select a project

Pass `--project <name>` before the prompt to save [project context](projects.md),
optionally with a skill. Edits, restart, and explicit retries retain the project
instructions and selected note paths. Each occurrence reads current global and
project facts; note contents are read on demand. Scheduled tools remain read-only.
Chat-created tasks inherit their owning session's project snapshot. The model can
inspect and control tasks only in that project, including unscoped tasks from
unscoped chats; owner CLI commands retain access to all tasks.

## Recurring schedules

Use a five-field cron expression and explicit timezone for a recurring task:

```fish
bun run start tasks add daily-summary --cron "0 9 * * *" --tz Europe/London "Summarize my notes"
```

One-off timestamps require `Z` or an explicit UTC offset. Cron schedules retain
local wall time across timezone changes. A missing local time during spring DST
shifts forward; a repeated time during autumn DST runs once. The database stores
times as UTC milliseconds. `show` includes final answers, run/session IDs, failures,
and skipped intervals. Each occurrence has a fresh session, current profile and
facts, read-only notes and conversation search/recall, page reading, and web search when
configured. Returned `save_note` and memory calls are rejected.
Use `--coding` before the prompt only for coding work that the chosen provider accepts.

Scheduled runs can use `poppet_history.read_session` after a conversation search
to read saved context around a match, or page forward with stable message IDs.
Results fit `POPPET_TOOL_BYTES` and mark shortened or omitted content. Recalled
statements remain historical data and should be cited by session/message IDs.
They cannot authorize note, memory, or task changes, or page fetches. Recalled
URLs never become web-search grants. Reading does not resume the saved session or
import its provider continuation. See [conversation context](chat.md#read-conversation-context).

## Read a supplied URL

A saved task prompt can explicitly supply a public URL for `poppet_web.fetch_page`:

```fish
bun run start tasks add page-summary --cron "0 9 * * *" --tz Europe/London "Summarize https://example.com/ and cite the source"
```

Each occurrence may read that URL through the same bounded [page reader](chat.md#read-a-supplied-url)
as chat. URLs mentioned only by a skill, note, prior conversation, or fetched page
are not authorized. The task retains read-only notes permissions. No page cache,
search account, or additional credentials are needed.

## Research with web search

[Browser automation](browser.md) is interactive-only. Scheduled runs receive no
browser tools, even when enabled for chat. Use web search and the protected page
reader for scheduled research.

With [web search configured](configuration.md#web-search), a saved prompt may ask
for current research without supplying a source URL:

```fish
bun run start tasks add weekly-research --cron "0 9 * * 5" --tz Europe/London "Search for recent Bun releases, read relevant sources, and cite them"
```

Each occurrence can search and read returned sources on a later model turn.
Search grants never carry over from older occurrences or saved history. Notes
and memory stay read-only. Search authentication, service, and rate-limit errors
fail that occurrence without retrying or pausing its inference provider. Use the
existing destination flags to deliver completed research through messaging.

## Missed work, pauses, and retries

The worker executes one occurrence at a time. Recurring times missed while stopped
are skipped. An overdue one-off runs once. A recurring task keeps at most one pending
or running occurrence; additional due times are recorded as skipped intervals.
Pending recurring summaries expire after 24 hours. One-off work never expires.
Pausing cancels pending work and keeps previous results. An active run needs an
explicit cancellation:

```fish
bun run start tasks cancel <occurrence-id>
bun run start tasks retry <occurrence-id>
bun run start tasks providers
bun run start tasks resume-provider openai-chatgpt
```

Quota failures pause scheduled requests for that provider until `resume-provider`.
Temporary and rate-limit failures delay subsequent work by 30 seconds, doubling
after further failures up to five minutes. A failed occurrence is never retried
automatically. `retry` creates a fresh session for an unsuccessful occurrence;
earlier runs remain available through chat inspection. Resume a paused task before
retrying it. A cancelled one-off needs `retry`, since it has no future occurrences.

## Scheduled command proposals

Owner-created reporting tasks can also receive a fixed command proposal
capability through `--proposal-command <json>`. It never permits scheduled
execution, even for an interactive automatic read. The model cannot grant or
change this capability. Monitor tasks and combined note/command capabilities
are rejected; source edits/clearing invalidate pending proposals. See
[scheduled command proposals](commands.md#scheduled-proposals).

## Clear tasks

To remove every task and its occurrence/skip history:

```fish
bun run start tasks clear
```

This works with the worker running or stopped. A running worker interrupts active
work before clearing and continues serving commands. Saved chat sessions and runs,
notes, facts, credentials, and provider quota pauses are retained. The command
returns the number of tasks removed, and repeating it on an empty list is safe.

See [worker modes](worker.md#foreground-modes) to run scheduling with messaging, and [task architecture](architecture.md#unattended-operation) for package ownership and execution contracts.

## Occurrence session titles

Each occurrence uses the task name as its session title, shortened to the same
80-character limit as chat titles. Scheduled runs skip title inference and have
no extra naming usage. The task prompt and read-only notes policy stay the same.
