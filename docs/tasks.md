# Scheduled tasks

[Documentation index](README.md)

Scheduled [MCP tools](mcp.md) are denied by default. A server's `scheduledTools`
must be an explicitly reviewed read-only subset of its interactive `tools`.
Annotations cannot grant permission. Restart the worker after changing these
lists. MCP results cannot authorize built-in mutations or page fetching.

## Create and inspect tasks

Select a provider and model as for chat, and sign in before running a task.
Tasks save that selection when added. The worker uses each saved selection even
if its environment selects a different model later.

For a quick test, schedule a review of recent conversations one minute from now:

Bash / POSIX sh:

```sh
when=$(bun -e 'console.log(new Date(Date.now() + 60_000).toISOString())')
poppet tasks add summary --at "$when" "Summarize recent conversations"
poppet worker run --tasks-only
```

fish:

```fish
set when (bun -e 'console.log(new Date(Date.now() + 60_000).toISOString())')
poppet tasks add summary --at $when "Summarize recent conversations"
poppet worker run --tasks-only
```

The worker prints timestamped lifecycle messages for starts, completed or failed
runs, interruptions, cancellation, skipped intervals, and task/provider pauses and
resumes. Occurrence messages include the task name and occurrence ID. Failures use
reason codes; prompts and model answers stay in saved results.
An idle worker does not print polling messages.

Leave the worker running. In another terminal using the same `POPPET_DATA_DIR`:

```sh
poppet tasks list
poppet tasks show <task-id>
poppet tasks pause <task-id>
poppet tasks resume <task-id>
```

## Edit and control the next execution

Edit a task without replacing its ID or losing its history:

```sh
poppet tasks edit <task-id> --name "Morning review"
poppet tasks edit <task-id> --prompt "Summarize open decisions from recent conversations."
poppet tasks edit <task-id> --cron "30 8 * * 1-5" --tz Europe/London
poppet tasks edit <task-id> --at 2099-10-22T09:00:00+01:00
poppet tasks skip-next <task-id>
poppet tasks snooze <task-id> --until 2099-10-22T10:00:00+01:00
poppet tasks run <task-id>
```

Edits change only supplied name, prompt, or schedule fields. A cron replacement
requires both expression and timezone; a one-off replacement requires a future
offset-qualified timestamp. Empty patches, unknown fields, conflicting schedules,
and timezone-only changes are rejected. Identical values are a no-op. Provider,
model, workload, skill, and destination remain unchanged.
Paused tasks may be edited without resuming them. Cancel a running occurrence
explicitly before using any of these controls on that task.

Every occurrence saves the definition and revision it executes. A name/prompt
edit replaces an unstarted occurrence with a new snapshot while retaining its
logical slot, ready time, and destination. The original stays cancelled in history.
A schedule change cancels pending work, clears its snooze, and computes the next
future slot. Editing a completed one-off's name/prompt does not rerun it; supply
a different future schedule to rearm it.

| Control     | Behavior                                                                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skip-next` | Consume exactly the selected pending occurrence or next slot. A recurring task keeps its cadence; a one-off has no next execution.                                                                                                  |
| `snooze`    | Delay that execution until a later future instant. `scheduledAt` keeps its original slot; `availableAt` is its effective ready time. The hold survives restart, and intervening cron slots do not build a backlog.                  |
| `run`       | Queue through the normal read-only runner and provider holds. Reuse eligible pending work, reject a future hold, preserve recurring cadence, and consume an unstarted one-off early. The receipt confirms queueing, not completion. |

The CLI inspects the revision and exact target before sending a mutation. The
worker rechecks both when committing and rejects stale requests instead of
selecting another slot. Receipts include the operation ID, revisions, changed
fields, affected occurrence IDs, next time, and snooze changes. Repeating
an operation ID returns its original receipt. Lost responses never trigger local
fallback or replay. Inspect `tasks show` and its latest 20 `changes` before
issuing another command after an unclear result.

Pausing cancels a snoozed occurrence. Resume uses the ordinary future cron cadence
and does not restore the snooze. Recurring expiration and retry freshness use
`availableAt`, with the existing 24-hour window after that time; one-offs do not
expire. Retries use the historical occurrence definition.
Unsupported actions fail explicitly. No additional login or model is required
to manage saved tasks.

## Manage tasks through chat

Tool-capable models can create, list, inspect, pause, and resume tasks when you
explicitly ask in CLI chat or an authorized messaging conversation. For example:

```text
Every Friday at 09:00 Europe/London, summarize recent project conversations and deliver the result here.
List my scheduled tasks.
Show task <task-id>.
Pause task <task-id>.
Resume task <task-id>.
```

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
skills, pages, and tool results cannot authorize task changes.

## Deliver results to Discord

Configure [Discord](gateways/discord.md), start `poppet worker run`, and copy an
existing authorized thread's ID. Pass it before the task prompt:

```sh
poppet tasks add daily-summary --cron "0 9 * * *" --tz Europe/London --discord-thread <thread-id> "Summarize recent conversations"
```

A running messaging worker validates the thread before creating the task.
Creation through the worker must finish within eight seconds, including queue
waiting and destination validation. An expired lookup cannot save a task afterward.

`gateway work` can validate new destinations but does not execute scheduled work;
`worker run --tasks-only` executes tasks but does not deliver their results. The combined
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

## Select a skill

Pass `--skill <name>` before the prompt to save a [local Markdown procedure](skills.md)
with a new task. Each occurrence copies the task's saved name and text into its
fresh session. File edits and deletion do not change existing tasks, including
explicit retries. Create a replacement task to use updated instructions.
`tasks show` includes the snapshot. Scheduled tools remain read-only: the memory tool is not
available, including when a selected skill requests changes.

## Recurring schedules

Use a five-field cron expression and explicit timezone for a recurring task:

```sh
poppet tasks add daily-summary --cron "0 9 * * *" --tz Europe/London "Summarize recent conversations"
```

One-off timestamps require `Z` or an explicit UTC offset. Cron schedules retain
local wall time across timezone changes. A missing local time during spring DST
shifts forward; a repeated time during autumn DST runs once. The database stores
times as UTC milliseconds. `show` includes final answers, run/session IDs, failures,
and skipped intervals. Each occurrence has a fresh session, current profile and
facts, conversation search/recall, page reading, and web search when
configured. Returned memory calls are rejected.
Use `--coding` before the prompt only for coding work that the chosen provider accepts.

Scheduled runs can use `poppet_history.read_session` after a conversation search
to read saved context around a match, or page forward with stable message IDs.
Results fit `POPPET_TOOL_BYTES` and mark shortened or omitted content. Recalled
statements remain historical data and should be cited by session/message IDs.
They cannot authorize memory or task changes, or page fetches. Recalled
URLs never become web-search grants. Reading does not resume the saved session or
import its provider continuation. See [conversation context](chat.md#read-conversation-context).

## Read a supplied URL

A saved task prompt can explicitly supply a public URL for `poppet_web.fetch_page`:

```sh
poppet tasks add page-summary --cron "0 9 * * *" --tz Europe/London "Summarize https://example.com/ and cite the source"
```

Each occurrence may read that URL through the same bounded [page reader](chat.md#read-a-supplied-url)
as chat. URLs mentioned only by a skill, prior conversation, or fetched page
are not authorized. The task retains read-only tool permissions. No page cache,
search account, or additional credentials are needed.

## Research with web search

[Browser automation](browser.md) is interactive-only. Scheduled runs receive no
browser tools, even when enabled for chat. Use web search and the protected page
reader for scheduled research.

With [web search configured](configuration.md#web-search), a saved prompt may ask
for current research without supplying a source URL:

```sh
poppet tasks add weekly-research --cron "0 9 * * 5" --tz Europe/London "Search for recent Bun releases, read relevant sources, and cite them"
```

Each occurrence can search and read returned sources on a later model turn.
Search grants never carry over from older occurrences or saved history. Memory
stays read-only. Search authentication, service, and rate-limit errors
return a failed tool result for the model to explain or handle within the run
budgets. They do not automatically retry or pause the inference provider. Use the
existing destination flags to deliver completed research through messaging.

## Missed work, pauses, and retries

The worker executes one occurrence at a time. A recurring task whose most recent
due time is within the catch-up window, 60 minutes by default, runs that time once;
earlier and older missed times are skipped (see [worker](worker.md#sleep-and-missed-schedules)).
An overdue one-off runs once. A recurring task keeps at most one pending
or running occurrence; additional due times are recorded as skipped intervals.
Pending recurring summaries expire after 24 hours. One-off work never expires.
Pausing cancels pending work and keeps previous results. An active run needs an
explicit cancellation:

```sh
poppet tasks cancel <occurrence-id>
poppet tasks retry <occurrence-id>
poppet worker providers
poppet worker resume-provider openai-chatgpt
```

Quota failures pause scheduled requests for that provider until `resume-provider`.
Temporary and rate-limit failures delay subsequent work by 30 seconds, doubling
after further failures up to five minutes. A failed occurrence is never retried
automatically. `retry` creates a fresh session for an unsuccessful occurrence;
earlier runs remain available through chat inspection. Resume a paused task before
retrying it. A cancelled one-off needs `retry`, since it has no future occurrences.

## Clear tasks

To remove every task and its occurrence/skip history:

```sh
poppet tasks clear
```

This works with the worker running or stopped. A running worker interrupts active
work before clearing and continues serving commands. Saved chat sessions and runs,
facts, credentials, and provider quota pauses are retained. The command
returns the number of tasks removed, and repeating it on an empty list is safe.

See [worker modes](worker.md#foreground-modes) to run scheduling with messaging, and [task architecture](architecture.md#unattended-operation) for package ownership and execution contracts.

## Occurrence session titles

Each occurrence uses the task name as its session title, shortened to the same
80-character limit as chat titles. Scheduled runs skip title inference and have
no extra naming usage. The task prompt and read-only tool policy stay the same.
