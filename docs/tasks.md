# Scheduled tasks

[Engineering notes](README.md)

A task is a saved prompt with a schedule. The worker runs each due occurrence as
a fresh scheduled chat run and can deliver the answer to a gateway. The
[user guide](https://poppet.run/docs/tasks/) covers the `tasks` commands.

| Module                                   | Owns                                                             |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `packages/tasks/src/task-schema.ts`      | Commands, schedules, timestamps, and `nextSlot`                  |
| `packages/tasks/src/task-store.ts`       | `TaskRepository`, scheduling, claims, and occurrence transitions |
| `packages/tasks/src/task-controls.ts`    | Edit, skip, snooze, and run-now transactions                     |
| `packages/tasks/src/task-records.ts`     | Task and occurrence records shared with the scheduler            |
| `packages/tasks/src/scheduler.ts`        | The wake queue, `reconcileTasks`, and `executeOccurrence`        |
| `packages/tasks/src/commands.ts`         | Task operations, inspection, and delivery state                  |
| `packages/tasks/src/chat-tools.ts`       | `ChatTasksLive` for the chat tool                                |
| `packages/tasks/src/task-socket.ts`      | The task command client for the worker socket                    |
| `packages/agent/src/tools/task-tools.ts` | `poppet_tasks.manage_tasks` and the `ChatTasks` capability       |
| `packages/agent/src/tools/task-note.ts`  | `poppet_tasks.save_note`                                         |
| `apps/cli/src/commands/tasks/`           | The `tasks` command and its argument parsing                     |

## Tasks and occurrences

The store holds at most 64 tasks (`limits.tasks`). A task saves its provider and model, an
optional [skill snapshot](skills.md#snapshots), a prompt, a schedule, an optional
end time, and an optional delivery destination. Every edit to the name, prompt,
or schedule creates a new revision.

An occurrence is one execution of one revision. It saves the definition and
revision it runs, its logical slot (`scheduledAt`), its ready time
(`availableAt`), and its destination. Claims and retries run from that
snapshot, so later edits never rewrite history. Each occurrence gets a fresh
session titled with the task name, cut to 80 characters. Scheduled runs skip
title inference.

The database stores times as UTC milliseconds. Task commands need no provider
login or model.

## Schedules

A task has one schedule form:

- `--at` takes a timestamp with `Z` or a UTC offset. It must be in the future.
- `--in` takes a positive whole number with `s`, `m`, `h`, or `d`. A day is 24
  elapsed hours. The CLI turns it into an absolute `--at` time once.
- `--cron` takes a five-field expression and needs `--tz`, which defaults to
  [`timeZone`](configuration.md#time-zone) when it is set. Effect Cron evaluates
  it.

Cron keeps local wall time. A local time skipped by a spring DST change moves
forward, and a time repeated in autumn runs once.

A cron task can have an end time, `jobs.end_at`, set with `--until` or `endAt`.
`nextSlot` in `task-schema.ts` is the only rule: a slot later than the end time
does not exist, and one exactly at it does. Creation, reconciliation, resume, the
controls, and schedule edits all advance `next_at` through `nextSlot`. So
`next_at` is never later than `end_at`, and a null `next_at` on a cron task means
it has ended. `tasks add` rejects an end time on a one-off, or one earlier than the
first slot.

The end time is not part of an occurrence's definition. Changing it keeps the
revision, and occurrences already queued still run, including a snoozed one held
past it. Reconciliation returns the tasks that just ran out of slots, so the
worker logs `task ended` once. Setting a later end time, or clearing it with
`--until none`, resumes the cadence from that moment with no backlog. Status and
`tasks show` report `ended`, distinct from `paused` and from a finished one-off's
`done`.

## Scheduler

The worker runs one occurrence at a time, from a one-second wake timer over
wall-clock UTC. `reconcileTasks` queues due work:

- An overdue one-off runs once and never expires.
- A recurring task has at most one pending or running occurrence. Other due slots
  become skipped intervals, which stop at the end time.
- After a delay or restart, the most recent missed slot runs once if it is within
  `tasks.catchUpMinutes` (default 60). Earlier slots are skipped. With `0`,
  startup skips missed recurring work, and a delayed timer runs the most recent
  slot only if it is less than a minute old.
- A pending recurring occurrence expires 24 hours after its `availableAt`.
- If a schedule cannot advance, the task pauses and the worker logs the failure
  and keeps processing other tasks.

Provider failures hold scheduled work for that provider in
`job_provider_pauses`. A quota hold has no end time, and no command clears it. A
completed occurrence for the provider clears its hold. A temporary or rate-limit
failure holds it for 30 seconds, doubling up to five minutes. `worker status`
shows the holds. Nothing retries a failed occurrence by itself.

The task service recovers state when it is built under a new store owner, before
agent or scheduler work starts. Recovery marks an occurrence whose run failed as
failed with the run's reason, and completes one whose run completed. The
repository's command lock serializes worker commands and occurrence claims.

## Scheduled run policy

`executeOccurrence` calls `Agent.send` with `origin: "scheduled"`. The run:

- gets the current profile and facts, conversation recall, page reading for URLs
  in the saved prompt, and the task's skill snapshot;
- never gets memory changes or `manage_tasks`, even when the prompt or skill asks;
- gets MCP tools only from `scheduledTools` and `scheduledReviewedTools`;
- reviews Bash and reviewed MCP calls against the saved prompt. By default
  (`approvals: "fail"`), a call that needs a person fails the occurrence at
  once. With `approvals: "wait"` (set globally in `tasks.approvals` or per task
  with `--approvals`) and either a task destination or a gateway home
  conversation, the run parks and posts an approval prompt there, keeping the
  occurrence `running` and capping the approval expiry at the smaller of
  `timeouts.approvalSeconds` and the next due slot. Once answered, the worker
  resumes the run and delivers its result through scheduled delivery (see
  [host commands](commands.md#scheduled-runs));
- does not expand `$name` mentions in the prompt;
- gets the task note and `save_note`.

The scheduled instructions let a conditional prompt answer with exactly
`NO_REPLY`. `isNoReply` from `@poppet/agent` matches only the whole trimmed
answer. Such a run completes, posts nothing, logs `completed no-action`, and shows
`noAction: true` in `tasks show` with its saved output.

## Controls

Controls act on the task's current definition. `skip_next`, `snooze`, and
`run` act on its next execution: the pending occurrence if there is one,
otherwise the unqueued `next_at` slot. Nothing needs a prior `show`.
`task-controls.ts` checks paused and running state, holds, expiry, and future
times in the same transaction as the change. A running occurrence blocks every
control until it finishes or is cancelled. Paused tasks can be edited. A lost
worker response never falls back to a local change.

`tasks edit` changes only the supplied fields:

- A name or prompt edit replaces an unstarted occurrence with a new snapshot,
  keeping its slot, ready time, and destination. The old one stays cancelled in
  history. Editing a completed one-off does not run it again.
- A schedule edit cancels pending work, clears a snooze, and computes the next
  future slot. A cron edit needs both the expression and the zone. Changing to a
  one-off clears the end time.
- An end time edit keeps the revision and the pending occurrence. An earlier end
  time cancels a snoozed occurrence whose slot is now past it, as `task-ended`.
- Empty patches, unknown fields, conflicting schedules, and zone-only changes are
  rejected. Identical values change nothing. Provider, model, skill, and
  destination never change.

| Control     | Behaviour                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skip_next` | Consumes the selected occurrence or slot. Recurring tasks keep their cadence. Skipping the last slot ends the task.                                                                     |
| `snooze`    | Moves `availableAt` to a later instant and keeps `scheduledAt`. The hold survives restart and builds no backlog.                                                                        |
| `run`       | Queues through the normal runner and provider holds. It reuses eligible pending work, rejects a future hold, and consumes an unstarted one-off early. The receipt confirms queueing.    |
| `pause`     | Cancels pending work, including a snooze, and leaves a running occurrence alone.                                                                                                        |
| `resume`    | Takes the next future slot. Missed slots and an old snooze do not come back.                                                                                                            |
| `cancel`    | Cancels the pending or running occurrence. With none, it fails.                                                                                                                         |
| `retry`     | Reruns the latest occurrence by slot, then revision, then insertion order, in a fresh session. It fails if that occurrence succeeded or is active. A paused task must be resumed first. |
| `remove`    | Deletes one task, its note, and its occurrence history. Sessions and runs stay.                                                                                                         |
| `clear`     | Deletes every task. A running worker interrupts active work first. Sessions, facts, and provider holds stay.                                                                            |

`cancel` and `retry` take `--occurrence <id>` to select a specific occurrence of
the task. Retry works on an unsuccessful occurrence whose slot is within the end
time and the 24-hour window, even after the task has ended. An ended task with
nothing pending rejects `skip_next`, `snooze`, and `run`. Snooze and run reject
an expired pending occurrence.

## Chat task management

`poppet_tasks.manage_tasks` is offered only in interactive runs. The agent
defines the strict arguments and the narrow `ChatTasks` capability, and the host
supplies `ChatTasksLive`. The agent does not import `@poppet/tasks`, because that
package already depends on agent skills.

Actions are `create`, `list`, `show`, `edit`, `pause`, `resume`, `skip_next`,
`snooze`, `run_now`, and `delete`. Each action reads only its own fields and names
a missing one in the error.

Every call passes batch validation before any tool runs. Preparation checks the
action's fields, task IDs, schedules, future times, skill files, and delivery
access. Then:

- The current run supplies the provider and model.
- The host clock adds the current UTC time, and the local time when `timeZone` is
  set, so the model can resolve relative dates.
- A recurring schedule needs an explicit zone or `timeZone`. One-off times and
  `endAt` need an offset. `endAt: "none"` clears the end time.
- A run can create at most 5 tasks (`limits.chatTaskCreatesPerRun`).
- A chat-created or chat-edited cron schedule must leave at least 5 minutes
  (`limits.chatTaskIntervalMinutes`)
  between every pair of consecutive runs. The check covers every listed minute,
  including the gap across the hour, so `0,30 * * * *` passes and `0,58 9 * * *`
  fails.
- Manual-only skills are refused.
- Editing, resuming, rescheduling, running, or deleting a task needs access to
  its saved destination. CLI chat can only touch tasks with local delivery.

The gateway rechecks the accepted owner and resolves the destination: the home
conversation by default, the current conversation for "here", `local`, or an
explicit `delivery: { conversationId }` checked by the current adapter. Arguments
cannot pick another gateway, account, owner, or provider. CLI chat creates tasks
with local delivery only.

`Store.commitToolCall` runs the task change and the completion of its tool
journal entry and message in one SQLite transaction. If saving the result fails,
the change rolls back. A completed call, keyed by run and call ID, returns its
saved result without running again. This is the only replay protection for task
changes. A committed change survives a later model failure. If the task changed
between preparation and commit, the call reports that the request is no longer
valid.

Chat runs directly in the owning process. It never takes another agent permit or
calls its own worker socket, and the existing timer picks up new work. Inspection
uses bounded ID-cursor pages, limits recent occurrences, shortens prompts to fit
the tool budget, and returns no model answers.

## Task notes

A task can keep one note of at most 4096 UTF-8 bytes between occurrences.
`executeOccurrence` reads the latest `job_notes` row and passes it as
`SendOptions.taskNote`. The conversation then adds the note to the instructions as
JSON and offers `poppet_tasks.save_note`. Because the note is in the instructions
and not the user message, it never grants page URLs and never reaches the Bash
reviewer.

`save_note` takes text or `null` and no task ID, so a run can write only its own
task's note. It writes nothing itself. Its arguments and result are the tool
journal entry. `TaskRepository.finish` commits the note in the transaction that
completes the occurrence. It reads the run's last completed `save_note` call and
appends a `job_notes` row unless the text is unchanged.

| Occurrence outcome              | Note                                                               |
| ------------------------------- | ------------------------------------------------------------------ |
| Completed, including `NO_REPLY` | The last saved value commits.                                      |
| Failed or cancelled             | Unchanged, even if a cancelled run finishes later.                 |
| Interrupted                     | Unchanged, unless recovery completes it because its run completed. |
| Retried                         | Starts from the current note. Only the retry's own value commits.  |
| Expired or skipped              | Unchanged.                                                         |

A note over the limit gets a tool result with its size and the limit, and the old
note stays. The worker adds `note-updated` to the completion log line.
`save_note` stays available after untrusted content, because change detection
saves values derived from pages. Page text can therefore reach the next
occurrence, but only as data under that occurrence's own restrictions.

Notes are task state, not part of a revision, so edits keep them.
`tasks clear-note` appends a `cli` row with a null text, under the same
running-occurrence check as the controls. Owners cannot write note text and chat
cannot clear notes. `tasks show --json` returns `note` with `text`, `origin`
(`occurrence` or `cli`), `occurrenceId`, `runId`, and `createdAt`, plus
`noteHistory`, newest first.

## Delivery

`--to <gateway>` selects that gateway's home conversation. `--to
<gateway>:<conversation-id>` selects one explicitly. Only the first colon
separates, so the ID may contain colons. Without `--to`, results stay local. The
adapter validates the ID and access before the task is saved. Creating a task
through the worker, including queue wait and validation, must finish in eight
seconds (`timeouts.taskOperationSeconds`), and a late lookup cannot save a task.

Each occurrence saves its own destination. Changing the home conversation affects
new tasks only. Before sending, the gateway rechecks the bot account, owner,
server, parent relationship, and current permissions. It never picks another
conversation when the saved one is inaccessible. A task for a removed adapter
keeps its history and waits for that adapter.

Completed results and failure notices go into the gateway's durable delivery
queue. Delivery is unique per occurrence and run, so a successful retry delivers
its own result. Temporary failures retry with bounded backoff. An uncertain send
is never resent. A delivery failure never changes a completed occurrence or
repeats inference. With [quiet hours](configuration.md#quiet-hours), a post that
becomes ready inside the window waits with `heldUntil` set to the window's end,
without using attempts. `tasks show` lists a `delivery` entry per run with chunk
states, message IDs, attempts, and `heldUntil`.

Results and notices are standalone posts. They never change the destination's
session binding, history, or name.

### Failure notices

A failed occurrence with a messaging destination posts one fixed message:

```text
Scheduled task "<name>" failed (<reason code>). Inspect it with: poppet tasks show <task-id>
```

The reason is the run's saved reason, or `before-start` when no run exists. A
notice never includes model output or error text. It posts once per failure
streak: a failure right after another failure posts nothing. Failures that
finished more than 24 hours ago post nothing, and neither do interrupted,
cancelled, or expired occurrences. A notice uses the run ID
`notice:<occurrence-id>:<finished-at>` in the delivery queue. The delivery queue
stops failure text that older versions queued under a failed run.

## Logs and status

The worker logs starts, completions, failures, interruptions, cancellation,
skipped intervals, task and provider pauses, and task endings, with the task name
and occurrence ID. Failures log reason codes. Prompts and answers stay in the
store. An idle worker logs nothing.

The task package owns status data and recent occurrence summaries. The host
supplies `WorkerConnections` from its provider layers. Status keeps only safe
metadata and caches it before model resolution, so it stays readable while a run
holds ChatGPT credentials. The cached status records when it was observed. It
reports local credentials and consent, not a live account check. The provider set
comes from the configured provider and saved tasks.
