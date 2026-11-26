# Worker

[Engineering notes](README.md)

`poppet worker run` is one long-running process that owns a data directory. It
runs scheduling, the configured gateways, optional web chat, and MCP connections,
and it serves CLI commands over a Unix socket. On macOS and on Linux with systemd,
`worker install` registers it as a user login service. The
[user guide](https://poppet.run/docs/worker/) covers the `worker` commands.

| Module                                     | Owns                                                           |
| ------------------------------------------ | -------------------------------------------------------------- |
| `apps/cli/src/commands/worker/host.ts`     | The scoped host runtime and socket routes                      |
| `apps/cli/src/commands/worker/requests.ts` | `WorkerRequests` for chat and queries                          |
| `apps/cli/src/commands/worker/service.ts`  | Action parsing, platform selection, and launch description     |
| `apps/cli/src/commands/worker/log.ts`      | Log writes and rotation                                        |
| `apps/cli/src/worker-background.ts`        | The installed launcher                                         |
| `packages/worker/src/socket.ts`            | Socket protection, body limits, deadlines, and client requests |
| `packages/tasks/src/scheduler.ts`          | `makeTaskWorker`                                               |
| `packages/platform/src/macos.ts`           | LaunchAgent plist and `launchctl` control                      |
| `packages/platform/src/linux.ts`           | systemd user unit and `systemctl --user` control               |
| `packages/platform/src/logs.ts`            | Protected log files and bounded log reads                      |

## Host

`host.ts` builds one scoped runtime. Scheduling, gateways, and web chat share the
store connection, agent, memory, provider resolver, and command functions, so
the CLI's chat slots and session ordering apply across all of them. There are no
helper processes. The store's owner lock stops a second worker from opening the
same data directory.

`makeTaskWorker` provides scheduling and task commands without opening a socket.
The host routes task requests to it and builds the gateway layer. Unconfigured
gateways stay off. A failed gateway restarts after one second, doubling up to
`timeouts.gatewayRestartMaxSeconds`, five minutes by default, without stopping
other gateways or scheduling. `worker status`
reports each gateway's `restarts` and `lastError`. A storage failure, or any other
fatal service failure, stops the host and its other services before storage is
released.

MCP connections start lazily and close on shutdown. Configuration is read at
start, so `config.json`, MCP permissions, and code changes need `worker restart`.
Shutdown interrupts active requests, closes connections, and releases the socket
and the owner lock. Queued work survives restart, and the gateway recovers a
committed answer without repeating its request. After a crash, the next owner
takes over storage even when the old PID was reused.

## Socket transport

The socket is `store/tasks.sock`, a `0600` socket in the `0700` store directory.
Clients check its ownership and permissions before connecting.

| Route          | Used for                                                  |
| -------------- | --------------------------------------------------------- |
| `/v1/commands` | Chat requests                                             |
| `/v1/queries`  | Memory, store status, chat inspection, and MCP inspection |
| `/v1/tasks`    | Task commands, validated by the task package              |
| `/v1/doctor`   | A bounded diagnostic snapshot                             |

Other routes return 404. Payloads reject unknown fields. Tasks and queries reply
with `{ok: true, value}` or `{ok: false, message}`. `WorkerRequests` lets the CLI
supply the chat and query handlers without importing CLI schemas into the task
package. The host runs the same command functions as local execution. A new chat
carries the client's provider and model, and a continued chat uses its saved
session. Budgets come from the worker's layers.

The listener handles each request in a scoped fiber, including body decoding.
Body reads have a 10-second deadline. A body can be at most 32 MiB, which fits
four 5 MiB attachments as base64 plus context and metadata, and the limit grows
when the attachment limits need more. An oversized request
gets a size error. The Unix-socket listener turns off Bun's idle timeout so a
quiet request can wait for a chat slot. Per-request timeout changes have no effect
on this transport.

A chat response owns a worker-scoped fiber and a bounded output queue. It streams
validated stdout and stderr frames and ends with a success or failure frame.
When the client disconnects, the worker interrupts the fiber, finalizes the run,
and releases the slot. Answers and session IDs go to the client, never to the
worker log. For a new session, the worker finishes the optional title request
before ending the response.

The CLI runs a command locally only when the socket is absent or refuses the
connection. Once a command is delivered, a transport error, malformed reply, or
missing final frame fails the command, and nothing replays it. Client and host
must run the same code, so restart the worker after updating. The wire protocol
is independent of store migrations. Task commands can still open the store when a
dead worker left its socket behind.

## Login services

`service.ts` parses actions, picks the platform, and passes absolute paths to Bun
and the entry point, the working directory, and `POPPET_DATA_DIR`. The platform
package defines the shared action, error, status, and launch types, and neither
platform module imports scheduling or CLI configuration. Other platforms report
no service, and `service` in `worker status` is `null`. The service environment
holds only the data directory. API keys stay in protected storage, and the worker
reads `config.json` at start. Moving the checkout or Bun needs uninstall and
install. Each data directory gets its own service.

`worker stop`, `worker uninstall`, and `worker logs` use only the data directory,
so they work when `config.json` is invalid. `worker restart` validates
configuration before it stops the service. Control operations finish in an
uninterruptible region, and each `launchctl` or `systemctl` call is killed after
35 seconds. Any failed inspection keeps the installed configuration. Starting an
already loaded worker does not interrupt it.

### macOS

The LaunchAgent lives in `~/Library/LaunchAgents`. `KeepAlive` restarts the
launcher with a 30-second throttle. Stopping removes the registration, which
sends SIGTERM, and Effect finalizers interrupt work and release resources. Only
exit code 113 from inspection means the service is absent. Restart waits up to 35
seconds for launchd to remove the old registration before loading it again. See
[Apple's launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).

### Linux

The unit lives in `$XDG_CONFIG_HOME/systemd/user`, or `~/.config/systemd/user`
when that variable is unset or relative. It sets `Restart=always`,
`RestartSec=30`, `TimeoutStopSec=30`, and `UMask=0077`. `KillMode=mixed` sends
SIGTERM only to the launcher, which forwards it as launchd's single signal would.
The rest of the group gets only the final SIGKILL. Unit values are quoted and
escaped for specifiers and variable expansion, and control characters are
rejected.

`install` writes the unit, reloads the user manager, and runs `systemctl --user
enable --now`. `stop` stops the unit and leaves it enabled. `uninstall` disables
it and removes the file. A unit that is present but not loaded is reloaded before
it is started or disabled. `systemctl show` reports an absent unit as
`LoadState=not-found`. Without lingering, the user manager stops after the last
session ends, and the worker with it. Commands need the user bus, so they fail
when `XDG_RUNTIME_DIR` is missing, as under `su` or in some containers. The
launcher's own startup errors go to the journal. See
[systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
and [systemd.unit](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html).

### Upgrading an installation

Some changes need `worker uninstall` then `worker install` once. Restarting keeps
the old service definition. Saved data, credentials, and logs stay.

- Installations that launch `tasks work` instead of `worker run`.
- Installations without the background launcher.
- Older LaunchAgents that saved settings or budget overrides in their
  environment. Those values still override `config.json` until reinstalled.

## Launcher and logs

The installed entry point is `worker-background.ts`. It holds its own log
ownership lock and starts `main.ts worker run` with piped stdout and stderr. It
forwards SIGINT and SIGTERM, drains both streams, and exits with the child's
code. It kills a child that has not exited after 25 seconds, inside the service
manager's 30-second stop deadline. A logging failure stops the child, so the
worker never runs without diagnostics. Foreground workers write to the terminal.

`log.ts` serializes writes to `logs/worker.log`, a `0600` file in a `0700`
directory. It rotates at `limits.workerLogBytes`, 5 MiB by default, and keeps three archives, `worker.log.1` to
`worker.log.3`, newest first, closing each file before renaming it. A single
chunk larger than the limit still rotates between writes. An existing oversized
log is archived whole. Symlinks, hard links, and non-regular files are rejected.
`worker logs` reads at most the last 64 KiB across the current file and the
archives, joining bytes across rotations, and never follows links or rotates.

Each entry is one [logfmt](https://brandur.org/logfmt) line from `io/src/log.ts`:
`time`, `level` (`info`, `warn`, or `error`), a fixed lowercase `msg`, then
fields. Values with spaces, quotes, or `=` are JSON-quoted, so multi-line text
stays on one line. Common fields are `task`, `occurrence`, `session`, `run`,
`provider`, `adapter`, `server`, `reason`, and `error`. Default logs exclude
prompts, answers, and tokens. With `chat.logReasoning`, `msg=thinking` entries
carry reasoning in `text`. With `chat.logTimings`, `msg=timing` entries carry
`stage` and `duration_ms`.

## Status

`worker status` works for foreground and installed workers. It reports the login
service, whether the worker answers, its PID, the active occurrence, task and
pending counts, the next scheduled time, provider holds, five recent outcomes,
gateway state under `worker.messaging`, and local connection metadata with
suggested actions. Connection metadata is not a live check. During a request that
holds the provider's credentials, the worker reports the last observed metadata,
marked `cached` with its time. Status includes the providers of saved tasks, even
when the CLI default differs. See [tasks](tasks.md#logs-and-status).

The worker does not keep the computer awake. See
[the scheduler](tasks.md#scheduler) for what runs after sleep or a restart.
