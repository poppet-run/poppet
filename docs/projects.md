# Project context

[Documentation index](README.md)

Select a project explicitly to give a chat or task its own instructions and facts. Poppet never infers a project from your working directory or
message. A project does not grant additional tools, credentials, or filesystem
access.

## Create and select a project

Create `<POPPET_DATA_DIR>/projects/acorn/PROJECT.md`. With the default data
directory:

```sh
mkdir -p ~/.config/poppet/projects/acorn
printf '%s\n' '# Acorn' 'Use concise milestone reviews. Flag unresolved decisions.' > ~/.config/poppet/projects/acorn/PROJECT.md
poppet projects list
poppet projects show acorn
poppet chat new --project acorn "Review the next milestone"
poppet chat interactive --project acorn
poppet tasks add acorn-review --project acorn --cron "0 9 * * 1" --tz Europe/London "Review progress"
```

Use your configured data directory if it differs from the default. Names contain
1–128 letters, digits, underscores, or hyphens; they cannot be paths. `PROJECT.md`
must be a regular UTF-8 file of at most 8192 bytes. Symlinks, hard links, invalid
UTF-8, and NUL bytes are rejected. `projects list` lists named directories;
`projects show` validates and displays current files without a model or database.

Put options before the prompt. Combine `--project acorn` with one
`--skill weekly-review` when desired. In an authorized messaging conversation:

```text
/new --project acorn --skill weekly-review Review progress
```

In a Discord parent channel, mention the bot before the command. `/status` shows
the saved project name. `/new <message>` starts an unscoped session; follow-ups
retain their current selection. Invalid selections leave the active binding
unchanged. Worker requests use the current versioned protocol and reject
unsupported fields before dispatch.

## Saved instructions and current facts

The store owner reads the project files when creating a session or task. It saves
`project: { name, content }`; unscoped and legacy records have `project: null`.
`chat show` and `tasks show` expose that saved snapshot. Continuing a chat,
restarting the worker, editing a task, or retrying an occurrence retains it even
after the files change or disappear. Create a new session or task to refresh it.
Tasks created through a project chat inherit its snapshot through the host.

Manage facts separately:

```sh
poppet memory remember --project acorn review.format "List decisions first"
poppet memory list --project acorn
poppet memory replace --project acorn review.format "List blockers first"
poppet memory forget --project acorn review.format
```

Memory commands default to global scope. The same key can exist globally and in
multiple projects. Each run reads current global facts and its selected project's
facts once, keeping them fixed across tool turns. Project facts allow up to 128
keys and an 8192-byte serialized fact snapshot; individual values keep the existing
4096-byte limit. Instructions, facts, tools, and history share the overall context
budget. Oversized context fails clearly rather than dropping project details.

Base tool rules and explicit current requests take precedence over saved
preferences. Compatible project preferences refine global preferences, including
a matching fact key. Skills supply procedures subject to those rules. Global and
project context are labelled separately.

The memory tool in a project chat can change only that project's facts, on an
explicit current request. Use an unscoped chat or the global CLI command to change
global facts. Scheduled work receives current facts but cannot write memory. Project files and retrieved content never authorize mutations.

## Recall and retention

Agent conversation search and reads include only sessions with the same selected
project. Unscoped chats recall only unscoped sessions. Guessing another session ID
cannot bypass that scope. Chat task inspection and controls use the same project
boundary. Owner CLI inspection and search can still inspect all projects; this
is context separation within one owner's data.

Deleting a project directory retains saved sessions, task snapshots, and facts.
`memory list --project acorn` reports `orphaned: true` when its directory is absent.
Forget retained facts explicitly with `memory forget --project acorn <key>`.
Forgetting does not redact earlier prompts, answers, or tool records. Reusing a
project name also reuses its fact scope; deletion does not move facts to global
memory.

## Manual validation

Create two projects with conflicting harmless preferences. Start a chat in each and an unscoped chat; inspect their saved selection
and check that replies use the intended context. Change a project file and a fact,
restart the worker, then continue: instructions stay saved and facts refresh.
Schedule one project review and repeat selection in an authorized messaging chat.
Live model instruction-following and useful reviews remain manual checks;
automated tests establish supplied context, persistence, and tool boundaries.
