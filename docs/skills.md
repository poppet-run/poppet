# Local Markdown skills

[Documentation index](index.md)

A skill is an owner-written procedure selected when creating a chat or scheduled
task. It uses Poppet's existing tools and permissions. Create one file at
`<POPPET_DATA_DIR>/skills/<name>/SKILL.md`, using UTF-8 Markdown of at most 8192
bytes. Names contain 1–128 letters, digits, underscores, or hyphens.

For example, save this as `skills/weekly-review/SKILL.md` under your data directory:

```markdown
# Weekly review

Search the notes for the project named in the user's prompt. Read relevant notes,
then summarize progress, unresolved questions, and next actions. Cite note paths.
Save the review only if the user explicitly asks and note writes are permitted.
```

Inspect and select it:

```fish
poppet skills list
poppet skills show weekly-review
poppet chat new --skill weekly-review "Review my Acorn project"
poppet tasks add weekly-review --cron "0 9 * * 1" --tz Europe/London --skill weekly-review "Review my Acorn project"
```

Put `--skill` and other options before the message or prompt. Select at most one
skill. `skills list` lists named directories; `skills show` reads and validates
the selected file. A missing skills root lists as empty. Inspection needs no
selected model, credentials, or database. Symlinks, hard links, non-regular files,
invalid UTF-8, and oversized content are rejected. Names cannot be paths.

Poppet reads the skill when creating the session or task and saves its name and
full text in SQLite. Continuing a chat, restarting the worker, or running a task
occurrence uses that saved snapshot. Editing or deleting the original file affects
only new sessions and tasks. Create a replacement session or task to refresh it.
`chat show` and `tasks show` include the saved `skill` object with `name` and
`content`; old records and ordinary sessions have `skill: null`.

The process owning the store loads the file. Commands sent through a running worker
use its data directory and the same validation as local commands. Skills join the
run's instructions below the base rules and count toward the existing context
budget. They cannot override explicit user requests or grant tool permissions.
Scheduled notes and memory remain read-only. A skill cannot authorize memory
changes; ordinary chat needs an explicit request in the current user message. Automatic session naming does not receive skills.

Combine a skill with `--project <name>` to add [project context](projects.md).
The project supplies instructions, facts, and optional note limits; the skill
supplies a procedure within those limits. Both snapshots persist independently.
Messaging accepts `/new --project acorn --skill weekly-review Review progress`.

Skills are single files. Poppet does not parse YAML metadata, follow references,
run scripts, download skills, choose them automatically, or let the agent write
them.

## Messaging sessions

In an authorized Discord thread, Telegram private chat, or WhatsApp private chat,
send a text command with a prompt:

```text
/new --skill weekly-review Review my Acorn project
```

In a Discord parent channel, mention the bot before the command. It creates a
thread as usual. The worker loads the local file using the same validation as the
CLI, saves a snapshot, and starts a fresh session. Ordinary follow-ups continue
that session and its saved skill across restart, even if the file changes or is
deleted. `/status` includes the current skill name.

Use `/new <message>` to start a fresh session without a skill. Both commands
replace only the conversation's active session binding; previous sessions,
history, and results remain available through `chat sessions` and `chat show`.
The new session uses the worker's configured provider/model. Commands run in
conversation order and do not cancel active work; use `/cancel` first if needed.
Duplicate delivery of the same command cannot create another session or run.

Missing prompts, invalid names, and unavailable or invalid skill files receive
an error reply without inference or changing the active session. Use `skills list`
and `skills show` locally to inspect available procedures. The command prefix is
removed from the prompt sent to the model and from generated titles. Skills keep
the existing prompt budgets and tool permissions. Scheduled-result delivery does
not change the messaging session or its selected skill.

Restart an existing worker after updating. Live selection and follow-up behavior
on each messaging platform remain manual validation.
