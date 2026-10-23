# Local Markdown skills

[Documentation index](README.md)

A skill is an owner-reviewed procedure selected when creating a chat or scheduled
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

```sh
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

## Draft a skill from a completed procedure

After a procedure succeeds, ask Poppet in the same chat to turn it into reusable
Markdown. For example:

```text
Turn the weekly review we just completed into a skill named weekly-review.
Return only a draft in your reply; do not save anything. Include required inputs,
steps using existing Poppet tools, pitfalls, and how to verify the result.
Generalize private project details and omit credentials and unrelated facts.
Identify any missing context or unverified steps rather than inventing them.
```

This is ordinary chat, including in authorized messaging conversations. There is
no skill-creation tool, approval command, or automatic publication. Poppet returns
text for the owner to review and revise before saving it manually.

Review the draft against what actually worked. Keep the procedure self-contained,
within the 8192-byte limit, and limited to tools and permissions Poppet already
has. Replace account names, paths, and destinations with inputs where appropriate.
Check for credentials and private information before placing it in the shared
local skill library. Project permissions still depend on the project selected
for the future chat or task, not the conversation that produced the draft.

The source is the conversation available to that model turn, which may omit older
exchanges under the history/context budgets. Recalled conversations expose bounded
user and final assistant text, not a complete execution trace. A successful model
reply is not proof that an external action succeeded. If the source is incomplete,
clarify the steps before saving. Keep the source session/run IDs in your own review
notes if you need provenance; this flow adds no separate audit records.

Save the reviewed Markdown with your editor at
`<POPPET_DATA_DIR>/skills/<name>/SKILL.md`. Use a new name to preserve an existing
skill. Run `poppet skills show <name>` to validate and inspect the saved file before
selecting it explicitly for a new chat or task. Invalid files remain unusable until
you correct them; Poppet does not repair or publish them automatically. Saving a
file does not change the current session or any existing session/task snapshots.

Validate a new procedure on a harmless input in a fresh chat first. Check actual
results and tool receipts, then try it in a scheduled task only if it works with
scheduled read-only permissions. Editing the file requires another new chat or
task to test the revised snapshot.

This flow changes only an owner-saved instruction file. It does not modify
Poppet's code, base rules, configuration, or permissions. Automatic learning or
selection, skill hubs, downloads, reference bundles, script execution, and a
publishing command are deferred.

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
