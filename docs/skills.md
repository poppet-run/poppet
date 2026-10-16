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
bun run start skills list
bun run start skills show weekly-review
bun run start chat new --skill weekly-review "Review my Acorn project"
bun run start tasks add weekly-review --cron "0 9 * * 1" --tz Europe/London --skill weekly-review "Review my Acorn project"
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

Skills are single files. Poppet does not parse YAML metadata, follow references,
run scripts, download skills, choose them automatically, or let the agent write
them. Selecting skills for Discord conversations is deferred.
