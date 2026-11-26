# Host commands

[Engineering notes](README.md)

`poppet_system.bash` runs shell commands as the OS account that runs Poppet, in
every kind of run: CLI, web chat, gateways, and scheduled tasks. There is no
project-directory restriction, no OS sandbox, and no sudo password. A model
reviews every invocation before it runs. The
[user guide](https://poppet.run/docs/commands/) explains this to owners.

| Module                                  | Owns                                                 |
| --------------------------------------- | ---------------------------------------------------- |
| `packages/agent/src/bash.ts`            | Tool definition, argument schema, and command policy |
| `packages/agent/src/action-review.ts`   | Reviewer requests for Bash and MCP actions           |
| `packages/agent/src/action-approval.ts` | Owner approval requests                              |
| `apps/cli/src/bash.ts`                  | The process runner                                   |
| `packages/gateway/src/approvals.ts`     | Pending approvals in the gateway                     |

## Arguments

The tool takes a command, an absolute working directory, and a timeout of 1 to
300 seconds.

## Review

Before each invocation, `reviewAction` sends a separate request to the run's
resolved provider and model. The reviewer gets only the owner's current message,
or the saved prompt in a scheduled run, plus the command, working directory, and
timeout. It has no tools, history, or continuation. It must return a valid
decision within `timeouts.actionReviewSeconds`, 30 seconds by default:

- `allow` runs this exact invocation once.
- `needs_approval` asks the owner in the originating gateway conversation. Runs
  without an approval callback stop instead. CLI, web chat, and scheduled runs
  have none.
- `deny` ends the run without running the command. The model cannot retry it in
  the same run.

A malformed decision, a reviewer failure, or a timeout stops the run without
starting Bash. The agent never caches a decision. The review policy covers
destructive operations, elevation, unknown scripts, credential access, data
transfer, and attempts to disable review or stop Poppet. Review cannot cover
scripts or files that change between review and execution.

The journal records dispatch only after review and any owner approval. Cancelling
while either is pending records an interruption before dispatch. A fatal review
failure also saves its reason in the transcript.

## Execution

`apps/cli/src/bash.ts` starts `/bin/bash --noprofile --norc` with `pipefail` and
closed stdin. The child inherits only `HOME`, `PATH`, `USER`, `LOGNAME`, `SHELL`,
`TERM`, `TMPDIR`, `LANG`, `LC_ALL`, and `LC_CTYPE`.

Each invocation gets its own process group. The runner kills the group on exit,
timeout, or cancellation, and closes its output pipes even when a detached
process still holds them. A process that leaves the group on purpose escapes this
cleanup.

The result has stdout, stderr, the exit code, and a truncation flag. Truncation
ends on a UTF-8 character boundary. A nonzero exit is an ordinary result. A
timeout or interruption ends the run with an uncertain outcome, and nothing
replays it. A completed receipt has `status: "completed"` and `approvedBy`, naming
the owner or the reviewer.

Command output is untrusted. It withdraws reviewed MCP tools for the rest of the
run, but Bash stays available because each later command is reviewed again.

## Owner approval

The gateway keeps pending approvals in memory for `timeouts.approvalSeconds`,
two minutes by default. Bash
commands and [reviewed MCP actions](mcp.md#reviewed-actions) share the same IDs.
A request ends when it expires, when the run is cancelled, or when the worker
restarts. An expired ID cannot come back.

The approval prompt shows the exact invocation and the reviewer's reason. It
escapes control characters and markup so both read as data. Every gateway
accepts `/approve <id>` and `/deny <id>` as control messages. An adapter that
implements the optional `approvals` capability also shows buttons and updates
them with the outcome. Discord and Slack implement it. Telegram uses text only.

- Only the configured owner, in the same conversation, can answer.
- The gateway checks access again before running the command.
- Answers resolve outside the inference queue, so a busy session does not delay
  them.
- The first answer settles the request. Later clicks or replies cannot run it
  again.
- Approval covers one invocation with its command, directory, and timeout.
- Updating the prompt message is best effort. A failed update cannot reopen a
  settled request.

For MCP actions, the journal records the owner's answer before dispatch.

## Scheduled runs

A scheduled run reviews each command against the saved prompt. A command that
needs approval fails the occurrence at once. The run never waits and never posts
an approval prompt. The worker logs the failure reason code, and `tasks show`
keeps the full reason and the blocked invocation. Earlier commands in the run are
not rolled back, and the recurring schedule stays active. A task with a messaging
destination can post a [failure notice](tasks.md#failure-notices).
