# Command execution and approval

[Documentation index](index.md) · [Owner approvals](approvals.md)

Commands are disabled by default. The owner can enable trusted local executables
and grant one CLI request access to a working directory. Poppet normally saves
an exact command proposal and waits for local owner approval. Preparing a
proposal starts no process. Approval executes saved arguments without inference.

Commands run under the owner's OS account. A working directory does not restrict
filesystem or network access. Only use trusted programs and trusted project code.
This feature provides no OS isolation. External action adapters remain gated.

## Configure and request a command

Add `commands` to the owner's `config.json`, with real absolute binary paths:

```json
{
  "commands": {
    "enabled": true,
    "executables": ["/absolute/path/to/bun", "/usr/bin/uname"],
    "automaticReads": false
  }
}
```

`POPPET_COMMANDS` replaces this entire section. The default is
`{"enabled":false,"executables":[]}`. Inspection executes no program. Restart
a running worker after changing configuration so it loads the current policy.
Cancel a pending proposal locally for immediate revocation. Disabling or removing
its executable also prevents approval after the owner process loads that change.

Put options before the message:

```fish
bun run start chat new --commands-root /absolute/path/to/project "Request a local test command for review"
bun run start chat send $session_id --commands-root /absolute/path/to/project "Request the next command for review"
```

Relative CLI roots resolve against the CLI's cwd before transport. The host
records the canonical root and filesystem identity. Permission expires with the
run and is not inherited by a session, project, or later message. Interactive
terminal prompts, messaging, documents, and voice cannot grant this capability.

The model receives `poppet_commands.request_command`, with an allowed absolute
executable, ordered string `args`, and relative `cwd`. Argument boundaries and
empty strings are preserved. No shell parsing, expansion, pipeline, redirection,
arbitrary environment, or interactive stdin is provided. Known shell/wrapper,
elevation, inline-evaluation, remote-operation and secret-bearing forms are
denied. These checks do not establish arbitrary binaries' or project scripts'
behavior. Build/test commands always require owner approval.

## Review and execute once

```fish
bun run start approvals list
bun run start approvals show $proposal_id
bun run start approvals approve $proposal_id
bun run start approvals cancel $proposal_id
```

`show` displays the complete structured payload, digest, source, expiry, executable
identity/digest, directory identities, environment policy, and limits. Arguments
and output escape terminal controls and bidi characters. A displayed command
line is never parsed for execution. Proposals expire after 24 hours and cannot
be edited. Cancel and prepare a new proposal to change an invocation.

Approval rechecks owner, expiry, current policy, executable digest, and directory
identities, then atomically claims one dispatch. Duplicate approval returns its
saved state/receipt. Cancellation only prevents pending work. It cannot undo
started work. A different proposal remains pending while a command is active.

The command reads live workspace files. These checks cannot atomically freeze
every input or bind path lookup to OS execution. Observed changes before dispatch
fail the proposal; trusted installations and workspace code remain necessary.

Each command has a private temporary HOME/TMPDIR and a minimal environment with
`PATH=/usr/bin:/bin` and `LANG=C`. Poppet forwards no worker credentials or loader
options. Programs can still read files available to the owner and may load
project configuration or dotenv files themselves.

Limits are one active command, 60 seconds of execution, 64 KiB of combined
stdout/stderr capture, 128 arguments, and 16 KiB of argument bytes. Capture
overflow stops the command. The executor drains both pipes and cleans up its
POSIX process group, allowing two seconds for SIGTERM and three for SIGKILL and
reaping. Temporary directories are removed afterward.

Receipts contain authority, times, spawn state, exit code/signal, separate output,
byte/truncation/decoding metadata, and cleanup status. Zero exit completes the
invocation without verifying the intended effect. Nonzero exit can leave partial
effects. Interruption, timeout, capture overflow, or unconfirmed cleanup after
dispatch produces `uncertain`. A proven pre-spawn failure is `failed`.

Crashes or failed receipt writes leave execution uncertain on restart. Lost
worker responses never trigger local fallback or replay. Inspect the receipt
and affected files before preparing a replacement. Forced owner-process death
can leave descendants alive; recovery never kills saved PIDs the OS could have
reused. Process groups cannot contain deliberately escaping code.

## Use a receipt in a follow-up

```fish
bun run start chat send $session_id --command-receipt $proposal_id "Explain the selected output"
```

The host attaches only this finished owner-scoped receipt from the same project
selection, as untrusted context. Selection grants no execution permission. If
the complete receipt exceeds the tool budget, inspect it locally and supply
only the needed output. No model tool browses receipts, and Poppet does not
automatically forward them to messaging channels. Output may contain private
data; automatic secret removal is not guaranteed.

## Automatic reads

`commands.automaticReads` is a separate opt-in. It still needs the per-run CLI
grant and executable allowlist. Only system `uname -s` and `uname -m` qualify,
with exactly one argument and the resolved system executable identity. Changed
arguments require manual approval if otherwise admitted. Hard denials remain.

Allowed reads use the same durable claim, bounded executor, and receipt. Their
authority is `rule`, with an ID/version, never owner approval. Git, package
managers, interpreters, build/test commands, and generic file readers have no
automatic rule.

## Scheduled proposals

An owner-created reporting task can propose one fixed invocation per occurrence:

```fish
bun run start tasks add "Review command" --at 2099-10-22T09:00:00Z --proposal-command '{"root":"/absolute/path/to/project","executable":"/usr/bin/uname","args":["-s"],"cwd":"."}' "Prepare the saved command for owner review when needed"
```

The host validates this capability and saves it with the task/occurrence
definition. The model can only propose that exact invocation. It never executes
even an automatic read. Monitor tasks and combined note/command capabilities
are rejected. Chat task tools cannot grant permission. Create a replacement
task to change its capability.

Task edits, clearing, or permission changes invalidate pending proposals;
receipts survive source cleanup. With a configured messaging destination, a
separate notice uses the existing durable queue. It contains the executable and
local review ID, without argv, environment, or output. Replies, reactions, and
delivery acknowledgements cannot approve. Uncertain delivery is not retried.

## Advisory model review

Optional `commands.reviewer` explicitly selects a registered provider and model:

```json
{
  "commands": {
    "enabled": true,
    "executables": ["/absolute/path/to/bun"],
    "reviewer": { "provider": "configured-provider", "model": "configured-model" }
  }
}
```

An interactive request needing review makes an additional provider request with
the structured command and bounded current owner request. It includes no
unrelated history, files, host credentials, or command output. The reviewer has
no tools, a ten-second timeout, bounded output, and no provider fallback. Its
`low_risk`, `high_risk`, or `uncertain` advice cannot grant execution, alter
arguments, or override policy. Missing, malformed, or failed advice leaves
manual approval. Interrupted review stays interrupted. Models cannot approve.

## Validation

Run the disposable compatibility probe without inference:

```fish
bun run packages/agent/src/test/command-check.ts
```

The pinned Bun 1.4.3 macOS probe passed for literal argv, cwd/minimal environment,
separate output, nonzero/spawn errors, SIGTERM-resistant children, descendants
holding pipes, parent-first exit, cancellation, and capture limits. The same
probe runs in the suite for Linux CI; remote CI has not run for this branch yet.

Integration checks use temporary stores, fixture processes, injected models,
worker sockets, and local delivery queues. They do not migrate the owner's
database or enable commands in the owner's configuration. Real-model command
preparation, a live scheduled notice, and reviewer usefulness/cost remain manual.
Validate those with disposable targets before relying on them.
