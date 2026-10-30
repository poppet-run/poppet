# Scheduled tasks

[Documentation index](README.md)

Scheduled [MCP tools](mcp.md) are denied by default. A server's `scheduledTools`
must be an explicitly reviewed read-only subset of its interactive `tools`.
Annotations cannot grant permission. Restart the worker after changing these
lists. MCP results cannot authorize built-in mutations or page fetching.

## Host commands

Scheduled runs can use the [Bash tool](commands.md). Each command is reviewed
against the saved job prompt using the job's provider and model. Allowed commands
can modify the machine. A denial, unavailable reviewer, or need for human approval
fails that occurrence immediately, without trying another command or waiting for
a person. The recurring schedule stays intact. Earlier completed commands are
not rolled back.

Failed runs only log their failure reason code and retain details in `tasks show`;
they do not post to a messaging destination. Approval failures retain the blocked
invocation and reason. Inspect them before retrying; later occurrences still run
on their normal schedule. Successful results go to the task's configured destination.

## Create and inspect tasks

Select a provider and model as for chat, and sign in before running a task.
Tasks save that selection when added. The worker uses each saved selection even
if its environment selects a different model later.

For a quick test, schedule a review of recent conversations one minute from now:

```fish
poppet tasks add summary --in 1m "Summarize recent conversations"
poppet worker run
```

`--in` accepts a positive whole number followed by `s`, `m`, `h`, or `d`.
For example, `30s`, `10m`, `2h`, or `1d`. A day is exactly 24 elapsed hours.
The CLI resolves the duration once and saves an absolute time. Use `--at` for
an exact timestamp, or `--cron` with `--tz` for recurring work. These schedule
forms cannot be combined.

The worker prints timestamped lifecycle messages for starts, completed or failed
runs, interruptions, cancellation, skipped intervals, and task/provider pauses and
resumes. Occurrence messages include the task name and occurrence ID. Failures use
reason codes; prompts and model answers stay in saved results.
An idle worker does not print polling messages.

Leave the worker running. In another terminal using the same `POPPET_DATA_DIR`:

```sh
poppet tasks
poppet tasks show <task-id>
poppet tasks pause <task-id>
poppet tasks resume <task-id>
```

Running `poppet tasks` lists saved tasks. The explicit `tasks list` command is also supported.

## Edit and control the next execution

Edit a task without replacing its ID or losing its history:

```sh
poppet tasks edit <task-id> --name "Morning review"
poppet tasks edit <task-id> --prompt "Summarize open decisions from recent conversations."
poppet tasks edit <task-id> --cron "30 8 * * 1-5" --tz Europe/London
poppet tasks edit <task-id> --at 2099-10-22T09:00:00+01:00
poppet tasks skip <task-id>
poppet tasks snooze <task-id> --until 2099-10-22T10:00:00+01:00
poppet tasks snooze <task-id> --for 1h
poppet tasks run <task-id>
```

Snooze accepts either `--until` or `--for`. A relative snooze is measured from
now, and must still be later than the selected execution's current ready time.

Edits change only supplied name, prompt, or schedule fields. A cron replacement
requires both expression and timezone; a one-off replacement requires a future
offset-qualified timestamp. Empty patches, unknown fields, conflicting schedules,
and timezone-only changes are rejected. Identical values are a no-op. Provider,
model, skill, and destination remain unchanged.
Paused tasks may be edited without resuming them. Cancel a running occurrence
explicitly before using any of these controls on that task.

Every occurrence saves the definition and revision it executes. A name/prompt
edit replaces an unstarted occurrence with a new snapshot while retaining its
logical slot, ready time, and destination. The original stays cancelled in history.
A schedule change cancels pending work, clears its snooze, and computes the next
future slot. Editing a completed one-off's name/prompt does not rerun it; supply
a different future schedule to rearm it.

| Control  | Behavior                                                                                                                                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skip`   | Consume exactly the selected pending occurrence or next slot. A recurring task keeps its cadence; a one-off has no next execution.                                                                                                  |
| `snooze` | Delay that execution until a later future instant. `scheduledAt` keeps its original slot; `availableAt` is its effective ready time. The hold survives restart, and intervening cron slots do not build a backlog.                  |
| `run`    | Queue through the normal scheduled runner and provider holds. Reuse eligible pending work, reject a future hold, preserve recurring cadence, and consume an unstarted one-off early. The receipt confirms queueing, not completion. |

Skip, snooze, and run act on the task's next execution when the command
commits: its pending occurrence if one exists, otherwise its next scheduled time.
A task with no upcoming execution needs a schedule edit first. Receipts include
changed fields, affected occurrence IDs, next time, and snooze changes. Lost responses never trigger local
fallback or replay. Inspect `tasks show` before issuing another command after an
unclear result.

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
Every weekday at 09:00 Europe/London, summarize recent project conversations and post in #daily-updates.
List my scheduled tasks.
Show task <task-id>.
Pause task <task-id>.
Resume task <task-id>.
```

The `poppet_tasks.manage_tasks` tool uses the existing scheduler. New tasks retain
the current session's provider and model, with a self-contained prompt
and an optional explicitly selected skill snapshot. They start fresh occurrence
sessions. The agent receives the current UTC time for relative dates and should
ask when the intended time, timezone, prompt, or task is unclear. One-off times
must be in the future and include a UTC offset; recurring schedules require an
explicit timezone. A receipt reports the saved ID, schedule, state, next time,
and destination.

Messaging tasks default to "home", the configured home channel. "Here" selects
the current conversation instead; "local" keeps results on the machine. To select
another channel or thread, include a channel mention or its ID in your request.
For the example above, select `#daily-updates` from Discord's channel mention picker.
A plain channel name requires clarification. The tool passes the selected ID as
`delivery: { conversationId: "..." }` to the current gateway, which validates the
destination and access before saving it. Discord destinations must be in the
configured server. Delivery rechecks access when the task finishes.
CLI chat supports local results only; use the CLI destination flags for messaging.
The model cannot select another gateway, account, owner, or provider.

Inspection uses bounded pages and flags shortened prompts or omitted occurrence
status. Use stable task IDs to pause, resume, or delete; duplicate names need clarification.
Pause cancels pending work and leaves active work running. Resume does not replay
missed recurring occurrences. Use `edit`, `skip_next`, `snooze`, and `run_now` for
the corresponding controls above. They act on the task's current state, so no
earlier `show` is needed. A snooze uses an absolute `until` timestamp with an
offset; ask about an unclear timezone. Each action reads only the fields it uses
and ignores the rest. Create needs a name, prompt, schedule, and delivery; every
action except create and list needs an ID; snooze needs `until`; and edit needs
at least one of name, prompt, or schedule. A missing field fails with a message
naming it. Ask "Delete my daily summary task" in Discord or CLI chat to use
`delete`. Deletion permanently removes the selected task and its occurrence
history, including pending work, while retaining conversations and runs.
A running occurrence prevents deletion; wait for it to finish or cancel it
via CLI first. Retrying occurrences, cancelling active runs, and changing
provider pauses remain CLI operations.

Task changes and their durable tool receipts commit together. A saved change
survives a later model failure or interrupted answer. Inspect `tasks list`,
`tasks show`, or the run's tool records in `chat show` before requesting a new
creation after an unclear result. Completed calls are not replayed. Scheduled
runs cannot use this tool, including its read actions. Historical conversations,
skills, pages, and tool results cannot authorize task changes.

## Deliver results to Discord

Configure [Discord](gateways/discord.md) with a home channel and start
`poppet worker run`. To deliver scheduled results there:

```sh
poppet tasks add daily-summary --cron "0 9 * * *" --tz Europe/London --to discord "Summarize recent conversations"
```

Use `--to discord:<channel-or-thread-id>` before the prompt to select an
explicit destination. A running messaging worker validates access before creating the task.
Creation through the worker must finish within eight seconds, including queue
waiting and destination validation. An expired lookup cannot save a task afterward.

The worker validates messaging destinations and delivers results through configured
adapters. Tasks without a messaging destination keep their results local.

Each occurrence saves its destination independently of later task or channel
configuration. Changing the home channel affects newly created tasks only. The
worker rechecks the saved bot account, owner, server, parent relationship, and current
channel or thread permissions before sending. It never chooses the last active
conversation or redirects a result when its destination becomes inaccessible.

Only completed results enter the gateway delivery queue, using the task's saved
destination. `tasks show`
includes the destination and a `delivery` array of run IDs, chunk states, message
IDs, and attempt counts. Each delivered run has its own receipt. An empty array
means no reply has been queued. Temporary delivery failures
retry with bounded backoff. Failed and uncertain sends remain inspectable;
uncertain sends are not resent automatically. Inspect the saved output before
manually reposting it. Delivery failures never change a completed occurrence or
repeat inference, and `tasks retry` rejects completed occurrences.

Results are standalone posts. They do not change the destination's conversation
history, session binding, or name. A stopped gateway resumes queued delivery when
it starts again. Already queued replies remain queued if task history is cleared.

`--to <gateway>` selects the gateway's home channel.
`--to <gateway>:<conversation-id>` selects an explicit destination. Only the first
colon is a separator; any remaining colons belong to the conversation ID.
Omit `--to` to keep results local. This replaces the former `--channel` and
`--conversation` flags.
The selected adapter validates its conversation ID and access before the task is saved.
Existing Discord task destinations keep their stored format. Tasks for removed adapters
retain their history and results but cannot deliver until that adapter is available again.

## Select a skill

Pass `--skill <name>` before the prompt to save a [local Markdown procedure](skills.md)
with a new task. Each occurrence copies the task's saved name and text into its
fresh session. File edits and deletion do not change existing tasks, including
explicit retries. Create a replacement task to use updated instructions.
`tasks show` includes the snapshot. Scheduled runs can use reviewed Bash commands. Memory writes and task management
remain unavailable, including when a selected skill requests them.

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

Scheduled runs can use `poppet_history.read_session` after a conversation search
to read saved context around a match, or page forward with stable message IDs.
Results are sized from the fixed 16 KiB tool-output budget, may run slightly over
it, and mark shortened or omitted content. Recalled
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
are not authorized. The task retains its scheduled tool restrictions; Bash commands are reviewed separately. No page cache,
search account, or additional credentials are needed.

## Research with web search

Use web search and the protected page reader for scheduled research.

With [web search configured](configuration.md#web-search), a saved prompt may ask
for current research without supplying a source URL:

```sh
poppet tasks add weekly-research --cron "0 9 * * 5" --tz Europe/London "Search for recent Bun releases, read relevant sources, and cite them"
```

Each occurrence can search and read returned sources on a later model turn.
Search grants never carry over from older occurrences or saved history. Memory
keeps its scheduled tool restrictions. Search authentication, service, and rate-limit errors
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
poppet tasks cancel <task-id>
poppet tasks retry <task-id>
poppet tasks providers
poppet tasks resume-provider openai-chatgpt
```

These commands take a task ID. Older CLI versions took an occurrence ID directly.
Restart an already-running worker after upgrading to use the task-based commands.

Cancel selects the task's pending or running occurrence. If none exists, use
`tasks skip` to skip its next scheduled execution. Retry selects the latest
occurrence by scheduled time, then revision and insertion order. It fails if that
occurrence succeeded or is still active; it never searches backward for a failure.
Use `--occurrence <occurrence-id>` with either command to select a particular
occurrence belonging to the task. For example:

```fish
poppet tasks retry <task-id> --occurrence <occurrence-id>
```

Quota failures pause scheduled requests for that provider until `resume-provider`.
Temporary and rate-limit failures delay subsequent work by 30 seconds, doubling
after further failures up to five minutes. A failed occurrence is never retried
automatically. `retry` creates a fresh session for an unsuccessful occurrence;
earlier runs remain available through chat inspection. Resume a paused task before
retrying it. A cancelled one-off needs `retry`, since it has no future occurrences.

## Remove a task

To permanently remove one task by its ID:

```sh
poppet tasks remove <task-id>
```

This works with the worker running or stopped. It removes the selected task and
its occurrence/skip history, including pending work, and retains conversations
and runs. Other tasks are unaffected. If the task has a running occurrence,
wait for it to finish or use `poppet tasks cancel <task-id>` first.
An unknown task ID returns an error.

## Clear tasks

To remove every task and its occurrence/skip history:

```sh
poppet tasks clear
```

This works with the worker running or stopped. A running worker interrupts active
work before clearing and continues serving commands. Saved chat sessions and runs,
facts, credentials, and provider quota pauses are retained. The command
returns the number of tasks removed, and repeating it on an empty list is safe.

See [worker documentation](worker.md#foreground-worker) to run scheduling with messaging, and [task architecture](architecture.md#unattended-operation) for package ownership and execution contracts.

## Occurrence session titles

Each occurrence uses the task name as its session title, shortened to the same
80-character limit as chat titles. Scheduled runs skip title inference and have
no extra naming usage. The task prompt and scheduled tool policy stay the same.

## Manual validation

Live checks for task controls passed on 2026-10-27 with the installed worker:
CLI edits kept task IDs and history, skip-next and run-now kept the cron cadence,
and a snoozed one-off ran once after a worker restart. A real model performed the
same controls through CLI chat and an authorized Discord thread, with receipts
and delivery of the result to that thread.
