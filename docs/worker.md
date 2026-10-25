# Worker

[Documentation index](README.md)

## Foreground modes

Choose one foreground mode for a data directory:

```sh
poppet worker run    # Scheduling and messaging
poppet worker run --tasks-only    # Scheduling only
poppet gateway work  # Messaging only
```

All three modes own enabled [MCP connections](mcp.md), started lazily on discovery
or an eligible agent run and closed on shutdown. CLI discovery uses these same
connections. `mcp servers` inspects them without starting a process. Restart the
worker after changing server configuration or to reconnect a failed server.

All three modes own one SQLite connection and serve task, chat, memory, and store-status commands
through `store/tasks.sock`, protected by the `0700` store directory and `0600`
socket. Commands use the worker when it is running and execute locally when it
is stopped. Inspecting saved data needs no model or provider credentials.
Task commands remain available in gateway-only mode, but no scheduled work is
executed. Task-only mode does not initialize messaging adapters. `worker status`
reports the host's selected services; `gateway status` reports whether messaging
is running. Only one mode can own a data directory at a time.
Interactive, scheduled, and messaging model requests share
[`chat.maxConcurrentRequests`](configuration.md) slots, 3 by default. Requests to one
session always run one at a time, so a CLI chat sent to a session that a Discord
thread is using waits for the thread's request. Chat streams to the
invoking terminal; Ctrl-C cancels that request and leaves the worker running.
Stopping the worker interrupts active requests and releases the socket and owner lock. After a crash,
a new owner automatically reclaims storage from a dead process, even if its PID has
been reused; unfinished work needs an explicit retry. A messaging adapter that
fails restarts on its own after a delay, from one second doubling to five minutes,
without stopping other adapters or scheduling; `gateway status` reports each
adapter's `restarts` and `lastError`. Storage failures still stop the worker. Already queued work survives restart, and a committed
answer is recovered without repeating its request. Task commands can open the
store even if a dead worker left its socket behind. A lost response to a delivered command does
not trigger local fallback. Task outcomes and provider pauses commit together;
recovery restores a quota pause from an unfinished occurrence's saved run.

## Browser resources

Optional [browser automation](browser.md) runs inside the process owning the chat.
Worker-backed CLI and messaging chats get separate run-owned browser resources.
Configuration changes require a restart. Cancelling a chat or stopping the worker
closes those resources. Browser tools are omitted from scheduled tasks.

## macOS login startup

On macOS, stop any foreground worker, then install a user LaunchAgent to start
the combined `worker run` host at login and keep it running while you are logged in:

```sh
poppet worker install
poppet worker status
poppet worker logs
```

Save persistent provider, model, and chat-limit settings in
`<data directory>/config.json` before installing. See [configuration](configuration.md).
Shell overrides apply to foreground commands and workers; installation does not
save them for the background worker.

Installation starts it immediately. It records the absolute Bun executable, CLI
entry point, current working directory, and `POPPET_DATA_DIR`. The worker reads
`config.json` on startup. After editing settings, use `worker stop` followed by
`worker start`. Keep the checkout and Bun executable in place; moving either
requires uninstalling and installing again. Each data directory has its own
launch agent. Manage it with the same `POPPET_DATA_DIR`.

`worker stop`, `worker uninstall`, and `worker logs` use only the data directory.
They remain available when `config.json` is invalid, so a configuration error does
not prevent stopping the worker or reading its logs. `POPPET_DATA_DIR` must still
be valid.

Older installations saved ordinary settings and budget overrides in their
LaunchAgent environment. Move the settings you want to keep into `config.json`,
then run `worker uninstall` followed by `worker install` once to remove those
saved overrides. Otherwise, they continue to take precedence over the file.
Saved data and credentials are retained.

If an existing installation launches `tasks work`, use `worker uninstall` followed
by `worker install` once to update it to `worker run`. Saved data and credentials
are retained. Restarting that old installation alone keeps its saved command and
now runs scheduling only.

API keys are excluded from the launch agent's environment. Save them first with
`provider login openrouter` or `provider login opencode-go`; ChatGPT uses its existing
protected sign-in storage. The worker refreshes credentials through the same
provider code as chat. Installation does not verify live inference.

New installations use a background launcher to capture and rotate the worker's
stdout and stderr. Existing installations need `worker uninstall` followed by
`worker install` once to select this launcher. Saved data, credentials, and logs
are retained. Foreground commands continue writing to the terminal.

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
its observation time. `worker status` works for the foreground worker too.
On other platforms, `launchAgent` is `null`; worker status remains available.

Inspect full task results using the existing commands:

```sh
poppet tasks list
poppet tasks show <task-id>
```

Lifecycle logs go to `<data directory>/logs/worker.log`, with `0700` directory and
`0600` file permissions. They exclude prompts, model output, and tokens.
The background launcher limits each new log file to 5 MiB and retains three
archives, `worker.log.1` through `worker.log.3`, newest first. It appends after
restart and rotates between writes, including when a single output chunk exceeds
the file limit. An existing oversized log is archived intact on the next write
and expires through the same retention policy. Archives have `0600` permissions;
symlinks, hard links, and non-regular log files are rejected.

`worker logs` prints at most the last 64 KiB across the current file and archives,
joining bytes across rotation boundaries. Reading logs does not rotate them.
The launcher forwards shutdown signals, waits for the worker to exit, and drains
its output before closing the log. A worker that does not exit within 25 seconds
is killed to stay within launchd's exit deadline. A logging failure stops the
worker rather than allowing it to run without captured diagnostics.

## Stop, start, and uninstall

```sh
poppet worker stop
poppet worker start
poppet worker uninstall
```

Stopping removes the running launchd registration and sends SIGTERM. Scoped
cleanup interrupts active work, records its outcome, closes the socket, and
releases storage. `stop` keeps login startup configured; `uninstall` disables it
and retains tasks, results, credentials, and logs. Inspection errors fail
the command and preserve the installed configuration. Lifecycle mutations finish
before an interruption returns; each launchctl subprocess has a 35-second timeout.
Starting an already
loaded worker does not interrupt an active request.

## Interactive commands

Chat can [manage scheduled tasks](tasks.md#manage-tasks-through-chat) through the
same worker and task repository. Task tools execute in the owning process and
share the scheduler's command lock; they do not submit another chat or a loopback
worker request. A running occurrence waiting for the shared agent does not block
interactive task changes. The existing reconciliation timer picks up new work.
Task changes are durable even when their final chat reply fails.

Chat, memory, session inspection, and `store status` work while it is running:

```sh
poppet memory set project.name Acorn
poppet chat new "What is the project called?"
poppet chat interactive
poppet chat sessions
poppet chat search "project"
poppet memory list
poppet store status
```

New chats use the invoking terminal's provider, model, and workload; continued
chats use their saved selection. The worker's startup budgets
apply to remote requests, including conversation-search result limits. Search
runs on the owning store connection and needs no provider request. Memory changes are loaded on the next run. Chat output
and session IDs go to the client terminal and are excluded from worker logs.
Request bodies have a 10-second read deadline and a 2 MiB transport limit,
which leaves room for the supported 1 MiB serialized chat context and command
metadata. Oversized requests report a size error without being retried.
Only an absent socket or refused connection permits local fallback. A lost,
incomplete, or incompatible response fails without replaying the command. Restart
the worker with `worker stop` followed by `worker start` after updating code.
The current protocol uses `/v1/commands` and `/v1/tasks`; other routes are rejected.

## Sleep and missed schedules

The worker does not keep the Mac awake. After sleep, it runs an overdue one-off
once. After sleep or a restart, a recurring task runs its most recent missed time
once if that time is within the catch-up window (`tasks.catchUpMinutes`, default
60), and records earlier missed times as skipped. Missed times older than the
window are all skipped. Setting the window to `0` restores the earlier policy:
restarts skip missed recurring work, and a delayed timer runs the earliest due
time. Summaries older than 24 hours expire. Failed or
interrupted requests are never automatically replayed.

## Manual validation

To manually test background execution, first save your provider and model in
`config.json`:

Bash / POSIX sh:

```sh
when=$(date -u -v+1M +%Y-%m-%dT%H:%M:%SZ)
poppet tasks add background-summary --at "$when" "Read project.md and summarize it"
poppet worker install
poppet worker status
# After the scheduled time, inspect the task ID returned by tasks add:
poppet tasks show <task-id>
poppet worker logs
```

fish:

```fish
set when (date -u -v+1M +%Y-%m-%dT%H:%M:%SZ)
poppet tasks add background-summary --at $when "Read project.md and summarize it"
poppet worker install
poppet worker status
# After the scheduled time, inspect the task ID returned by tasks add:
poppet tasks show <task-id>
poppet worker logs
```

Use `worker start` instead of `install` if it is already installed. Repeat with a
sleep/wake cycle, then stop/start the worker and confirm a completed occurrence
does not run again. Automated tests simulate clock jumps, crash recovery, and
SIGTERM cleanup. Actual login startup, physical sleep/wake, and live provider
execution remain manual checks. Other platforms can use `worker run` in the
foreground; background installation currently supports macOS only.

Rotation tests exercise retention, restart, stdout/stderr capture, log inspection,
and shutdown with isolated files and subprocesses. After reinstalling a real
LaunchAgent, check `worker status` and `worker logs`, then stop/start it and confirm
new log entries append. Native launchd behavior remains a manual check.

## Optional naming work

Chat rename commands use the same local-or-worker routing as chat inspection.
`chat interactive [session]` uses the same worker transport for each entered
message. Waiting at the prompt does not hold storage. Session metadata is returned
with the existing stderr announcement, so one-shot clients keep their output and
interactive clients can retain the session after a failed turn.

After printing an interactive answer, the worker finishes the optional bounded
title request before completing that command response. The gateway starts naming
only after the answer's delivery chunks are confirmed sent. Naming shares the
agent's serialized model access with chat and scheduled runs. Shutdown can cancel
naming without changing the completed chat run, delivery state, or provider pause
state. Durable attempt claims prevent a restart from repeating title inference.
Managed thread synchronization considers each title once, with a one-time fetch
to reconcile an uncertain update rather than a persistent retry queue.
