# Memory

[Documentation index](README.md)

## Saved facts

Save preferences and facts with stable keys:

```sh
poppet memory remember answer.style "Keep answers concise"
poppet memory list
poppet chat new "How should you answer my questions?"
poppet memory replace answer.style "Explain the reasoning"
poppet chat new "How should you answer my questions?"
poppet memory forget answer.style
poppet memory list
```

Memory management requires no login or model. Chat still requires a configured
provider/model and its connection. `remember` creates a new key; it rejects an
existing key so facts cannot be overwritten accidentally. `replace` and `forget`
require an existing key. Keys start with a letter or digit and contain only letters,
digits, dots, underscores, and hyphens, up to 128 characters. Values must be nonempty,
have no surrounding whitespace, and fit in 4096 UTF-8 bytes. The store holds up to
128 facts per scope. Listing includes keys, values, update times, and source run IDs when
available; CLI-created facts have no source run.

## Ask the model to change a fact

Tool-capable models can call `poppet_memory.memory` during ordinary chat,
including the interactive prompt and authorized messaging conversations. Restart
an existing worker after updating so its agent advertises the new tool:

```sh
poppet chat new "Remember that I prefer concise answers, under answer.style"
poppet chat send $session_id "Replace answer.style with Explain the reasoning"
poppet chat send $session_id "Forget the saved fact answer.style"
poppet memory list
```

Use the session ID printed by the first command. The model is instructed to change
memory only on an explicit request in the current user message. It must not infer
facts to save or treat profile, personality, skills, retrieved content, history, or
tool results as permission. Runtime checks validate the arguments and allowed tools;
the model interprets the user's intent, as it does for requested note writes.

The tool has three actions, `remember`, `replace`, and `forget`. It takes `action`,
`key`, and `value`; forgetting requires a JSON `null` value. Existing keys are never
implicitly overwritten. Facts are already supplied in context, so the tool does not
need a listing action. Models without tool support can still use supplied facts;
manage their facts with the CLI commands above.

The tool uses the same `Memory` service and local database as the CLI. Remembering
and replacing set `sourceRunId` to the active run, which the model cannot supply or
forge. The agent checks the next fact snapshot against `POPPET_FACTS_BYTES` before
writing and returns a small acknowledgement instead of repeating the value. The
current run's prompt stays fixed; the tool result confirms the change and the next
run loads it into its snapshot. Independently issued CLI changes retain their
existing budget and snapshot behavior.

Every request and outcome is kept in the tool journal visible through `chat show`.
Graceful cancellation lets a started mutation finish and record its result. A
storage error or a committed change whose result cannot be saved remains uncertain
and is never automatically replayed. Completed memory changes persist even if a
later tool or model turn fails. Inspect `memory list` and `chat show` before retrying.
Forgetting removes the fact, but does not redact earlier messages or tool records.
The tool does not edit `profile.md`, `soul.md`, notes, or credential files.

Scheduled runs retain their starting fact snapshot but have no memory-writing
tool, even when a task or selected skill asks for changes. The shared
`readOnlyTools` policy also excludes note writes.

Automated checks cover local/worker chat, mutation provenance, restart, argument
validation, byte limits, protected scheduled runs, cancellation, and storage/journal
failures. Live model intent handling and the three memory actions remain manual
checks. Ask for one fact to be remembered, continue and replace it, then forget it;
inspect `memory list` and `chat show` after each step, including from a fresh chat.

## Project facts

Memory commands default to global facts. Pass `--project <name>` to list,
remember, replace, or forget only that project's facts. Keys are unique per scope;
the same key can exist in global memory and several projects. Each project run
reads global context and its current project facts once. Project facts have a
fixed 8 KiB snapshot budget within the existing overall context budget.

A project chat's memory tool writes only its own project facts, with host-bound
run provenance. Change global facts through an unscoped chat or the default CLI
commands. Scheduled runs cannot write either scope. Deleting project files
retains facts; `memory list --project <name>` reports an orphaned directory and
`memory forget --project <name> <key>` removes an individual fact explicitly.
See [project context](projects.md) for selection, preference precedence, and
instruction snapshots.

## Profile

Edit `<POPPET_DATA_DIR>/profile.md` for your name, background, and preferences.
With the default data directory, this is `~/.config/poppet/profile.md`. A missing
profile is empty and is never created automatically. Existing profiles must be
regular UTF-8 files; profile symlinks are rejected.

## Personality and tone

Edit `<POPPET_DATA_DIR>/soul.md` to set Poppet's personality, tone, and communication
style. With the default data directory, this is `~/.config/poppet/soul.md`.
For example:

```markdown
Be warm, direct, and concise. Use dry humor sparingly.
Disagree when there is a good reason, and admit uncertainty plainly.
```

`soul.md` describes how Poppet speaks; `profile.md` describes you. Personality
preferences do not authorize tool execution or override Poppet's tool and file
access rules. A missing, empty, or whitespace-only `soul.md` keeps the default
personality. The file is never created automatically and follows the same UTF-8
and regular-file requirements as `profile.md`.

## Context across sessions

Every run reads the current personality, profile, and saved facts once, then keeps
that snapshot across its model/tool turns. New sessions and resumed sessions pick
up changes on their next run, including scheduled tasks and messaging. Memory is
shared across sessions and providers within their global or selected project
scope in the same data directory. Facts are included
in key order as personal context, with no
provenance metadata sent to the model. The memory tool is reserved for explicit
changes requested by the current user; Poppet does not automatically extract facts
from conversations. Agent-curated facts with revision history
are planned in [phase 31](phases/31.md).

## Limits and deletion

Personality, profile, and fact budgets default to 8 KiB each, controlled by
`POPPET_SOUL_BYTES`, `POPPET_PROFILE_BYTES`, and `POPPET_FACTS_BYTES`. Oversized
content fails clearly instead of silently omitting preferences. All count toward
`POPPET_CONTEXT_BYTES` alongside instructions, tool definitions, and history.
A malformed or oversized personality file, profile, or facts block fails before
resolving a provider; a context overflow fails before inference. Forgetting removes
the saved fact from future snapshots; existing
conversation messages and note files remain in their own storage.

See [memory architecture](architecture.md#explicit-memory) for the service and local implementation.
