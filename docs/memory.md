# Memory

[Documentation index](index.md)

## Saved facts

Save preferences and facts with stable keys:

```fish
bun run start memory remember answer.style "Keep answers concise"
bun run start memory list
bun run start chat new "How should you answer my questions?"
bun run start memory replace answer.style "Explain the reasoning"
bun run start chat new "How should you answer my questions?"
bun run start memory forget answer.style
bun run start memory list
```

Memory management requires no login or model. Chat still requires a configured
provider/model and its connection. `remember` creates a new key; it rejects an
existing key so facts cannot be overwritten accidentally. `replace` and `forget`
require an existing key. Keys start with a letter or digit and contain only letters,
digits, dots, underscores, and hyphens, up to 128 characters. Values must be nonempty,
have no surrounding whitespace, and fit in 4096 UTF-8 bytes. The store holds up to
128 facts. Listing includes keys, values, update times, and source run IDs when
available; CLI-created facts have no source run.

## Profile

Edit `<POPPET_DATA_DIR>/profile.md` for your name, background, and preferences.
With the default data directory, this is `~/.config/poppet/profile.md`. A missing
profile is empty and is never created automatically. Existing profiles must be
regular UTF-8 files; profile symlinks are rejected.

## Personality and tone

Edit `<POPPET_DATA_DIR>/SOUL.md` to set Poppet's personality, tone, and communication
style. With the default data directory, this is `~/.config/poppet/SOUL.md`.
For example:

```markdown
Be warm, direct, and concise. Use dry humor sparingly.
Disagree when there is a good reason, and admit uncertainty plainly.
```

`SOUL.md` describes how Poppet speaks; `profile.md` describes you. Personality
preferences do not authorize tool execution or override Poppet's tool and file
access rules. A missing, empty, or whitespace-only `SOUL.md` keeps the default
personality. The file is never created automatically and follows the same UTF-8
and regular-file requirements as `profile.md`.

## Context across sessions

Every run reads the current personality, profile, and saved facts once, then keeps
that snapshot across its model/tool turns. New sessions and resumed sessions pick
up changes on their next run, including scheduled tasks and messaging. Memory is
shared across sessions and providers in the same data directory. Facts are included
in key order as personal context, with no
provenance metadata sent to the model. Chat has no memory-writing tool and does
not infer or automatically save facts from conversations.

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
