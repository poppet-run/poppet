# Scheduled tasks

[Documentation index](index.md)

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

## Deliver results to Discord

Configure [Discord](discord.md), start `bun run start worker run`, and copy an
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

Configure [Telegram](telegram.md), run the combined worker, and pass
`--telegram-chat <owner-id>` before the prompt. Only the configured owner's private
chat is supported. It uses the same destination snapshots, authorization rechecks,
and delivery inspection as Discord. Choose one destination per task;
`--telegram-chat`, `--whatsapp-chat`, and `--discord-thread` cannot be combined.

## Deliver results to WhatsApp

Configure and pair [WhatsApp](whatsapp.md), run the combined worker, and pass
`--whatsapp-chat <owner-phone>` before the prompt. Use the configured owner's
international phone digits without `+`. The adapter validates the connected
account and private chat, then uses the same saved destination and delivery queue.
Ambiguous sends remain uncertain without automatic replay.

## Select a skill

Pass `--skill <name>` before the prompt to save a [local Markdown procedure](skills.md)
with a new task. Each occurrence copies the task's saved name and text into its
fresh session. File edits and deletion do not change existing tasks, including
explicit retries. Create a replacement task to use updated instructions.
`tasks show` includes the snapshot. Scheduled tools remain read-only: neither note writes nor the memory tool is
available, including when a selected skill requests changes.

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
facts, and only `read_note` and `search_notes`. A returned `save_note` call is rejected.
Use `--coding` before the prompt only for coding work that the chosen provider accepts.

## Read a supplied URL

A saved task prompt can explicitly supply a public URL for `poppet_web.fetch_page`:

```fish
bun run start tasks add page-summary --cron "0 9 * * *" --tz Europe/London "Summarize https://example.com/ and cite the source"
```

Each occurrence may read that URL through the same bounded [page reader](chat.md#read-a-supplied-url)
as chat. URLs mentioned only by a skill, note, prior conversation, or fetched page
are not authorized. The task retains read-only notes permissions. No page cache,
search account, or additional credentials are needed.

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
