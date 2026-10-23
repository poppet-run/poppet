# Host commands

[Documentation index](README.md)

Poppet provides `poppet_system.bash` to tool-capable models in CLI, Discord, and
scheduled runs. It runs with the filesystem and process permissions of the OS
account running Poppet. There is no project-directory restriction or OS sandbox.
It does not grant root access or supply a sudo password.

## Review and execution

The tool requires a command, an absolute working directory, and a timeout from
one to 300 seconds. Before every invocation, a separate request to the current
provider/model reviews the command against the current owner message or saved
job prompt. This adds a model request per command. The reviewer has no tools,
chat history, or conversation continuation.

The decision is one of:

- `allow`: run the exact invocation once.
- `needs_approval`: ask the owner in Discord; fail a cron or CLI run that cannot
  obtain a human decision.
- `deny`: end the run without executing the command.

Malformed responses, reviewer failures, and review timeouts stop the run without
starting Bash. A denial cannot be retried by the model within the same run.
Review considers destructive operations, elevation, unknown scripts, credential
access, data transfers, and attempts to disable review or stop Poppet itself.
An LLM decision is fallible. It cannot guarantee the behavior of scripts, tools,
or files that change between review and execution.

Bash starts with `--noprofile --norc` and `pipefail`; `BASH_ENV` and `ENV` are
removed. Other environment variables come from Poppet's process. Commands can
therefore access the host account's files and environment, including credentials.
Standard input is closed. Output includes stdout, stderr, exit code, and whether
it was truncated. A nonzero exit is returned to the agent; an interrupted or
timed-out command ends the run with an uncertain outcome and is never replayed.

Each invocation has its own process group. Timeout and cancellation kill that
group, and background children are also stopped when Bash exits. To manage a
persistent service, use the machine's service manager rather than `command &`.
Processes that deliberately detach from the group are outside that cleanup guarantee.

## Discord approval

Poppet shows the exact invocation and reason in the original conversation. Reply
`/approve <id>` or `/deny <id>`. Only the configured owner in the same authorized
conversation can answer, and access is checked again before execution. Approval
covers that command, directory, and timeout for one invocation. It grants no
future permissions.

Requests expire after two minutes or when the run is cancelled or the worker
restarts. Expired IDs cannot be revived. Ask for the operation again to obtain a
new reviewed invocation. CLI commands that need approval stop and direct you to
Discord; CLI commands the reviewer allows run normally.

## Scheduled runs

Cron uses the same review. A command requiring human approval fails the
occurrence immediately and is never left waiting. Its saved invocation and
reason are included in the failure delivered to the task's messaging destination.
The recurring schedule remains active. Earlier commands may have completed;
failure does not roll them back. Inspect the saved task and machine state before
requesting a retry.

Other scheduled restrictions remain: no memory writes, task management, or browser
tools, and MCP tools must be explicitly listed in `scheduledTools` as read-only.
The reviewed Bash tool can perform host changes authorized by the saved prompt.

## Validation

Automated checks use fixture model decisions and isolated local shell commands.
They cover execution, bounded output, process cleanup, denied and unavailable
reviews, owner approvals, conversation isolation, expiry, replay rejection, and
failed cron delivery. They do not establish a live model's review accuracy.

For a manual smoke test, ask for a harmless filesystem check in Discord, verify
its Bash receipt, then request an operation whose review asks for approval and
deny it. Confirm no command ran. Repeat with approval, then schedule a harmless
job and verify its result arrives. Finally, verify a scheduled command needing
approval produces a failure notification without executing.
