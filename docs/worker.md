# Worker

[Documentation index](index.md)

## Foreground modes

Choose one foreground mode for a data directory:

```fish
bun run start worker run    # Scheduling and messaging
bun run start tasks work    # Scheduling only
bun run start gateway work  # Messaging only
```

All three modes own one SQLite connection and serve task, chat, memory, and store-status commands
through `store/tasks.sock`, protected by the `0700` store directory and `0600`
socket. Commands use the worker when it is running and execute locally when it
is stopped. Inspecting saved data needs no model or provider credentials.
Task commands remain available in gateway-only mode, but no scheduled work is
executed. Task-only mode does not initialize the Discord adapter. `tasks status`
reports the host's selected services; `gateway status` reports whether messaging
is running. Only one mode can own a data directory at a time.
Interactive, scheduled, and messaging model requests share one runner. Chat streams to the
invoking terminal; Ctrl-C cancels that request and leaves the worker running.
Stopping the worker interrupts active requests and releases the socket and owner lock. After a crash,
a new owner automatically reclaims storage from a dead process; unfinished work
needs an explicit retry. Already queued work survives restart, and a committed
answer is recovered without repeating its request. Task commands can open the
store even if a dead worker left its socket behind. A lost response to a delivered command does
not trigger local fallback. Task outcomes and provider pauses commit together;
recovery restores a quota pause from an unfinished occurrence's saved run.

## macOS login startup

On macOS, stop any foreground worker, then install a user LaunchAgent to start
the combined `worker run` host at login and keep it running while you are logged in:

```fish
bun run start worker install
bun run start worker status
bun run start worker logs
```

Installation starts it immediately. It records the absolute Bun executable, CLI
entry point, current working directory, validated configuration paths, and any
explicit chat budgets. Keep that checkout and Bun executable in place. To change
saved settings or move the checkout, uninstall and install again. Each data
directory has its own launch agent. Manage it with the same `POPPET_DATA_DIR`.

If an existing installation launches `tasks work`, use `worker uninstall` followed
by `worker install` once to update it to `worker run`. Saved data and credentials
are retained. Restarting that old installation alone keeps its saved command and
now runs scheduling only.

API keys are excluded from the launch agent's environment. Save them first with
`auth login openrouter` or `auth login opencode-go`; ChatGPT uses its existing
protected sign-in storage. The worker refreshes credentials through the same
provider code as chat. Installation does not verify live inference.

## Status and logs

`worker status` reports whether the launch agent is installed and loaded, whether
the worker is responding, its PID and active occurrence, task and pending counts,
the next scheduled timestamp, provider pauses, and five recent outcomes. It also
shows local connection metadata and the account and plan-usage permission where
supported, with actions for login, consent, quota resume, and failed work.
Running and stopped status include providers assigned to saved tasks, even when
the current CLI default provider differs.
Connection metadata is not a live provider verification. During an active
credential-owning request, the last observed metadata is labelled `cached` with
its observation time. `tasks status` works for the foreground worker too.

Inspect full task results using the existing commands:

```fish
bun run start tasks list
bun run start tasks show <task-id>
```

Lifecycle logs go to `<data directory>/logs/worker.log`, with `0700` directory and
`0600` file permissions. They exclude prompts, notes, model output, and tokens.
`worker logs` prints at most the last 64 KiB. Log rotation is not implemented;
remove or truncate old logs while the worker is stopped if needed.

## Stop, start, and uninstall

```fish
bun run start worker stop
bun run start worker start
bun run start worker uninstall
```

Stopping removes the running launchd registration and sends SIGTERM. Scoped
cleanup interrupts active work, records its outcome, closes the socket, and
releases storage. `stop` keeps login startup configured; `uninstall` disables it
and retains tasks, results, notes, credentials, and logs. Inspection errors fail
the command and preserve the installed configuration. Lifecycle mutations finish
before an interruption returns; each launchctl subprocess has a 35-second timeout.
Starting an already
loaded worker does not interrupt an active request.

## Interactive commands

Chat, memory, session inspection, and `store status` work while it is running:

```fish
bun run start memory remember project.name Acorn
bun run start chat new "What is the project called?"
bun run start chat sessions
bun run start chat search "project"
bun run start memory list
bun run start store status
```

New chats use the invoking terminal's provider, model, and workload; continued
chats use their saved selection. The worker's saved notes directory and budgets
apply to remote requests, including conversation-search result limits. Search
runs on the owning store connection and needs no provider request. Memory changes are loaded on the next run. Chat output
and session IDs go to the client terminal and are excluded from worker logs.
Request bodies have a 10-second read deadline and a 2 MiB transport limit,
which leaves room for the supported 1 MiB serialized chat context and command
metadata. Oversized requests report a size error without being retried.
Only an absent socket or refused connection permits local fallback. A lost,
incomplete, or incompatible response fails without replaying the command. Restart
an older worker with `worker stop` followed by `worker start` after updating code.

## Sleep and missed schedules

The worker does not keep the Mac awake. After sleep, it runs an overdue one-off
once. For a delayed recurring task, it runs the earliest due occurrence once and
records later missed occurrences as skipped. Summaries older than 24 hours expire.
Restart skips recurring work missed while the process was stopped. Failed or
interrupted requests are never automatically replayed.

## Manual validation

To manually test background execution with your configured provider and model:

```fish
set when (date -u -v+1M +%Y-%m-%dT%H:%M:%SZ)
bun run start tasks add background-summary --at $when "Read project.md and summarize it"
bun run start worker install
bun run start worker status
# After the scheduled time, inspect the task ID returned by tasks add:
bun run start tasks show <task-id>
bun run start worker logs
```

Use `worker start` instead of `install` if it is already installed. Repeat with a
sleep/wake cycle, then stop/start the worker and confirm a completed occurrence
does not run again. Automated tests simulate clock jumps, crash recovery, and
SIGTERM cleanup. Actual login startup, physical sleep/wake, and live provider
execution remain manual checks. Other platforms can use `worker run` in the
foreground; background installation currently supports macOS only.

## Optional naming work

Chat rename commands use the same local-or-worker routing as chat inspection.
After printing an interactive answer, the worker finishes the optional bounded
title request before completing that command response. The gateway starts naming
only after the answer's delivery chunks are confirmed sent. Naming shares the
agent's serialized model access with chat and scheduled runs. Shutdown can cancel
naming without changing the completed chat run, delivery state, or provider pause
state. Durable attempt claims prevent a restart from repeating title inference.
Managed thread synchronization considers each title once, with a one-time fetch
to reconcile an uncertain update rather than a persistent retry queue.
