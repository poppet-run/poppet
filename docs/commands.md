# Host commands

[Engineering notes](README.md)

`poppet_system.bash` runs shell commands as the OS account that runs Poppet, in
every kind of run: CLI, web chat, gateways, and scheduled tasks. There is no
project-directory restriction, no OS sandbox, and no sudo password. A model
reviews every invocation before it runs. The
[user guide](https://poppet.run/docs/commands/) explains this to owners.

| Module                                            | Owns                                                 |
| ------------------------------------------------- | ---------------------------------------------------- |
| `packages/agent/src/tools/bash.ts`                | Tool definition, argument schema, and command policy |
| `packages/agent/src/approvals/action-review.ts`   | Reviewer requests for Bash and MCP actions           |
| `packages/agent/src/approvals/action-approval.ts` | Owner approval requests                              |
| `apps/cli/src/bash.ts`                            | The process runner                                   |
| `packages/gateway/src/approvals.ts`               | Pending approvals in the gateway                     |
| `packages/gateway/src/approval-format.ts`         | Shared approval view model and Markdown formatting   |

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
- `needs_approval` parks the run and asks the owner in the originating gateway
  conversation. See [waiting runs](chat.md#waiting-runs). CLI, web chat, and
  scheduled runs cannot wait and stop instead.
- `deny` ends the run without running the command. The model cannot retry it in
  the same run.

A malformed decision, a reviewer failure, or a timeout stops the run without
starting Bash. The agent never caches a decision. The review policy covers
destructive operations, elevation, unknown scripts, credential access, data
transfer, and attempts to disable review or stop Poppet. Review cannot cover
scripts or files that change between review and execution. A waiting run widens
that gap to as long as the approval stays open, because a resumed run does not
review the command again.

The journal saves the reviewer's decision in the call's `review`, or
`unavailable` when the review fails, and records dispatch only after review and
any owner approval. Cancelling while either is pending records an interruption
before dispatch. A fatal review failure also saves its reason in the transcript.
`chat show` and `tasks show` list saved reviews under "Reviewed calls".

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

When a gateway run needs approval, it parks in the store and stays open for
`timeouts.approvalSeconds`, one hour by default (up to 24 hours). Waiting holds
no session permit, request slot, or run deadline. Bash commands and
[reviewed MCP actions](mcp.md#reviewed-actions) share the same IDs. A request
ends when the owner answers, when it expires, when `/cancel` cancels the
conversation, or when a newer owner message supersedes the waiting run. An ended
ID cannot come back.

`gateway_approvals` records each prompt's conversation, run, prompt message, and
display state alongside the store's `approvals` table. Waiting approvals survive
a worker restart: on start, the gateway posts any unsent prompt for a live
approval (reusing deterministic nonces), requeues decided approvals that have
not resumed yet, and updates native prompts for settled approvals, best effort.
A late answer to a known request gets a reply that says how it ended instead of
"No matching pending approval".

`approval-format.ts` builds a structured view model and Markdown fallback for
each request. It escapes control characters, bidi characters, and code fences so
untrusted text stays data. Every gateway accepts `/approve <id>` and `/deny <id>`
as control messages, and the terminal can list and answer pending approvals
from any surface with `poppet approvals list`, `poppet approvals approve <id>`,
and `poppet approvals deny <id>`. An adapter that implements the optional `approvals`
capability renders native controls and updates the prompt once settled:

- Discord renders an amber embed with a live countdown (`<t:unix:R>`), **Approve
  once** and **Deny** buttons, and a **Show details** button when truncated
  (replying ephemerally or attaching `approval-details.json`). On settlement it
  removes the buttons and updates the embed with the outcome and decider.
- Slack renders structured Block Kit `mrkdwn` blocks with `<!date^...>` expiry
  and the same buttons, replacing the buttons with a status context line once
  settled.
- Telegram renders HTML-formatted prompts with inline **Approve once**,
  **Deny**, and (when truncated) **Show details** buttons, answering callback
  queries and editing the message to remove buttons once settled.

- Only the configured owner, in the same conversation, can answer.
- The gateway checks access again before running the command.
- Answers resolve outside the inference queue, so a busy session does not delay
  them.
- The first answer settles the request. Later clicks or replies cannot run it
  again.
- Approval covers one invocation with its command, directory, and timeout.
- Updating the prompt message is best effort. A failed update cannot reopen a
  settled request.

The journal records the owner's answer before dispatch. A call whose approval
was not saved does not run.

## Scheduled runs

A scheduled run reviews each command against the saved prompt. By default
(`tasks.approvals: "fail"`), a command that needs approval fails the occurrence
at once without waiting or posting a prompt. When opted into `approvals: "wait"`
(globally in `config.json` or per task via `tasks add`/`tasks edit --approvals`)
and a messaging destination or gateway home conversation is available, the run
parks and posts the approval prompt there, keeping the occurrence `running` and
capping expiry at the smaller of `timeouts.approvalSeconds` and the next due
slot. Without a destination or home conversation, it still fails at once. The
worker logs the failure reason code, and `tasks show` keeps the full reason.
Earlier commands in the run are not rolled back, and the recurring schedule
stays active. A task with a messaging destination can post a
[failure notice](tasks.md#failure-notices).
