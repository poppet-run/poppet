# Skills

[Engineering notes](README.md)

A skill is an owner-written Markdown procedure at
`<POPPET_DATA_DIR>/skills/<name>/SKILL.md`. A run gets a skill in one of three
ways: selected when a session or task is created, named with `$name` in a
message, or read by the model from the skill index. A skill adds instructions
and never adds permissions. The [user guide](https://poppet.run/docs/skills/)
covers writing skills.

| Module                                 | Owns                                                    |
| -------------------------------------- | ------------------------------------------------------- |
| `packages/agent/src/skills.ts`         | `Skills`, `SkillsLive`, file validation, `isManualOnly` |
| `packages/agent/src/skill-index.ts`    | The bounded skill index                                 |
| `packages/agent/src/skill-tools.ts`    | `poppet_skills.view_skill`                              |
| `packages/agent/src/skill-mentions.ts` | `$name` detection and loading                           |
| `packages/agent/src/context-files.ts`  | Bounded file reads shared with project files            |

## Files

- A name has 1 to 128 letters, digits, underscores, or hyphens. Names cannot be
  paths.
- `SKILL.md` is UTF-8 and at most 8192 bytes.
- Reads reject symlinks, hard links, non-regular files, and invalid UTF-8.
- A missing skills directory lists as empty.
- A first line of exactly `<!-- manual-only -->` marks the skill manual-only.
  `isManualOnly` checks only that line and parses no other metadata.

Poppet does not parse YAML front matter, follow references, run scripts, or
download skills, and no tool lets the agent write one. `skills list` and
`skills show` need no model or credentials and do not open the database.

The process that owns the store reads skill files. Creation requests through the
worker carry only the skill name, and the worker resolves it from its own data
directory with the same validation.

## Snapshots

Selecting a skill saves its name and full text. The store schema defines the
bounded snapshot and a nullable snapshot column on sessions and jobs. Every later
turn, restart, and task occurrence uses the snapshot, so editing or deleting the
file affects only new sessions and tasks. Task execution copies the job's
snapshot into each occurrence session without touching the filesystem. A missing
or invalid selection fails before the session or task is created.

The agent adds one snapshot to the instructions, below the base rules, and the
context estimate counts its bytes. `chat show` and `tasks show` include `skill`
with `name` and `content`, or `null`. Automatic session naming never sees skills.

## Skill index

When the host supplies `Skills` and the skill-index budget is nonzero, the
conversation builds an index at run start and offers the read-only
`poppet_skills.view_skill` tool.

- The index lists at most 64 valid skills (`limits.skillIndexEntries`). Each entry is the name plus a
  description from the first heading and the start of the first paragraph.
- It leaves out invalid files and manual-only skills.
- Each description is at most 240 bytes (`limits.skillDescriptionBytes`).
- It fits the 8 KiB budget (`limits.skillIndexBytes`). A budget of 0 turns the
  index and `view_skill` off. When it does not fit, it drops descriptions, then
  names, and says it was truncated.
- A skill selected for the session is marked as already supplied.

`view_skill` refuses manual-only skills. Its result goes into the tool journal,
so a resumed session sees the text the model read even if the file changed.
Viewing stays available in scheduled runs and after untrusted content, and grants
nothing.

## Mentions

`Agent.send` is the only place that resolves `$name`, so CLI chat, web chat, and
gateways behave the same. `mentionedSkills` matches a standalone `$name` outside
inline code and fenced code when a skill directory has exactly that name, case
included. `${name}`, `\$name`, `a$name`, `$name/path`, `$name=1`, and `$name.sh`
do not match. Trailing sentence punctuation is allowed. Everything else stays
text, so `$HOME` is left alone unless a skill is called `HOME`.

- A message can name at most four skills (`limits.skillMentions`).
- Mentions load before the run is queued. An invalid named skill fails the
  message before any run is saved.
- The session's selected skill is not loaded again.
- Manual-only skills can be named, because the owner named them.
- Attachment text is not scanned.
- Scheduled runs skip mentions, because an occurrence must not read skill files.

The snapshots go in the user message's optional `skills` field. The conversation
loop renders that field into the message text for the current turn and for
replayed history before context assembly. The estimate therefore counts the
bytes sent, adapters never see the field, and later turns reuse the saved text.
Page URL grants still come only from the owner's original text.

## Gateway sessions

The gateway parses `/new --skill <name> <message>` and `/new <message>` after it
authorizes the sender. Both go through the durable request queue, not the
immediate `/status` and `/cancel` path, and run in conversation order.

A valid command creates a session with the worker's configured provider and
model and the optional snapshot, then updates the conversation binding and the
inbox entry in one transaction. The reserved inbox run ID keeps the new session's
identity stable across a crash before binding, so recovery reuses the saved
snapshot without reading the file again. Duplicate delivery cannot create a
second session. A selection error gets a reply and leaves the binding unchanged.

The parsed prompt, without the command prefix, is what the model sees and what
titles use. `/status` includes the skill name. Naming updates check the session
identity, so stale work cannot rename a newer binding. Adapters need no
skill-specific code.

Chat task creation through `poppet_tasks.manage_tasks` refuses manual-only skills.
`tasks add --skill` and `/new --skill` accept them.
