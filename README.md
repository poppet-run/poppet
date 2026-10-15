# Poppet

A small personal AI agent for local use, built with TypeScript, Bun, and Effect.

The project has a CLI, validated configuration, ChatGPT sign-in, and a shared
streaming model interface. OpenCode Go supports a small set of coding models.
OpenRouter supports concrete text models from its public catalog.
SQLite stores sessions, messages, and runs. Chat streams answers and resumes
saved sessions and can read, search, and save local notes. An editable profile and
explicitly saved facts provide context across sessions. A foreground worker executes
durable one-off and recurring tasks. On macOS, a LaunchAgent can keep that worker
running after you close the terminal and start it at login.
The same worker can connect a Discord bot, with one saved Poppet session per
thread.

## Development

Use Bun 1.4.3, pinned in `mise.toml` and `package.json`.

```fish
bun install --frozen-lockfile
bun run start --help
bun run start config
bun run check
```

The repository uses Bun workspaces for `@poppet/cli`, `@poppet/config`,
`@poppet/provider`, `@poppet/provider-openai`, `@poppet/provider-opencode`,
`@poppet/provider-openrouter`, `@poppet/provider-protocol`, `@poppet/credentials`,
`@poppet/store`, `@poppet/agent`, `@poppet/memory`, `@poppet/tasks`,
`@poppet/platform`, `@poppet/platform-macos`, `@poppet/gateway`, and
`@poppet/channel-discord`.
Root `start` and `dev` commands run the CLI from the
repository directory, so relative configuration paths keep the same meaning.

`bun run dev` watches the CLI source. `bun run format` formats files with Oxfmt.
`bun run lint:fix` applies safe Oxlint fixes. `bun run check` checks formatting,
linting, types, and Bun tests. GitHub Actions runs the same checks on pushes
and pull requests. Bun's built-in type checker covers each workspace and the root
tooling configs. TypeScript stays installed for editor support. To check one
workspace, use `bun run --filter '@poppet/config' typecheck`
or `bun run --filter '@poppet/provider-openai' test`.

Use `bun run test` for the suite or `bun run test <path>` for focused tests.
The test runner starts Bun with an empty environment, a temporary home, and dotenv
loading disabled. It blocks external HTTP requests and system commands, and passes
the same guards to CLI subprocesses. Workspace test scripts use this runner too.
Direct `bun test` is rejected unless the isolation runner started it.

The Oxfmt and Oxlint configs are based on
[Memoir's configuration](https://github.com/tombell/memoir-app), with React and JSX
lint plugins removed for this CLI project. Type checking also covers the configuration files.

Oxlint also enforces the generic and Effect rules from
[anti-slop](https://github.com/dmmulroy/anti-slop), vendored under
`tools/oxlint/anti-slop/`. These rules are errors. Keep `@oxlint/plugins` and Oxlint
at the same pinned version. See the [upstream record](tools/oxlint/anti-slop/UPSTREAM.md)
for the source revision and update notes. Vendored code and agent tooling are
excluded from linting and formatting.

## Configuration

| Variable               | Default                  | Purpose                                                                                          |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| `POPPET_APP_NAME`      | `Poppet`                 | Application name used for initial ChatGPT registration                                           |
| `POPPET_DATA_DIR`      | `~/.config/poppet`       | Credential and conversation storage                                                              |
| `POPPET_NOTES_DIR`     | `<data directory>/notes` | Notes tools' permitted directory                                                                 |
| `POPPET_PROVIDER`      | `openai-chatgpt`         | `openai-chatgpt`, `opencode-go`, or `openrouter`                                                 |
| `POPPET_MODEL`         | Unset                    | Explicit model ID for verification and new chat sessions                                         |
| `POPPET_CONTEXT_BYTES` | `65536`                  | Context size estimate in UTF-8 bytes, including instructions and continuation; maximum `1048576` |
| `POPPET_HISTORY_TURNS` | `20`                     | Maximum previous complete exchanges sent to the model; maximum `100`                             |
| `POPPET_OUTPUT_TOKENS` | `2048`                   | Requested output limit when supported, capped by model metadata; maximum `32768`                 |
| `POPPET_MODEL_TURNS`   | `8`                      | Maximum model requests per run; range `1–32`                                                     |
| `POPPET_TOOL_CALLS`    | `16`                     | Maximum tool calls per run; range `1–64`                                                         |
| `POPPET_TOOL_BYTES`    | `16384`                  | Maximum UTF-8 bytes per serialized tool result; range `1024–65536`                               |
| `POPPET_PROFILE_BYTES` | `8192`                   | Maximum UTF-8 bytes in `profile.md`; range `1–65536`                                             |
| `POPPET_FACTS_BYTES`   | `8192`                   | Maximum UTF-8 bytes of serialized saved facts sent to the model; range `1–65536`                 |

Paths become absolute relative to the current working directory. Explicit values
must be nonempty and have no leading or trailing whitespace. Use a full path when
configuring a directory in the environment; literal `~` is not expanded.

For example, in fish:

```fish
set -lx POPPET_DATA_DIR "$HOME/.local/share/poppet"
set -lx POPPET_NOTES_DIR "$HOME/Documents/Notes"
bun run start config
```

The `config` command prints settings. It does not create directories, open a
database, or contact OpenAI. Credentials use separate protected storage and never
appear in this output.

Chat budgets must be positive integers. They are validated for chat execution;
session listing and inspection work independently of these budgets.

## Discord thread chat

Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications).
Enable its Message Content intent and install it in your server with the bot
scope. In the intended parent text channel, give it View Channel, Read Message
History, Create Public Threads, and Send Messages in Threads permissions. It
does not need Administrator. Use Discord's Developer Mode to copy the bot user,
your user, server, and parent channel IDs.

Start with a private parent channel that only trusted people can read. The
configured user is the only person who can invoke Poppet, but everyone with
channel access can read replies containing personal memory and notes.

Select an assistant-capable provider and model, then save the bot token through
stdin. The token is never accepted as an argument. For fish:

```fish
read --silent --prompt-str 'Discord bot token: ' discord_token
printf '%s\n' $discord_token | bun run start gateway discord setup <bot-id> <your-user-id> <server-id> <parent-channel-id> --key-stdin
set -e discord_token
bun run start tasks work
```

Replace the angle-bracket placeholders with Discord IDs before running the
setup command. Additional parent channel IDs can follow the first one. Settings
and the redacted token live in `<POPPET_DATA_DIR>/channels/discord.json`, protected
with `0600` file and `0700` directory permissions. Model-provider credentials
remain separate. Restart an existing worker after changing channel settings;
on macOS, use `worker stop` followed by `worker start`. The installed worker reads
the saved settings without placing the bot token in its LaunchAgent environment.

Mention `@Poppet` with a message in an allowed parent text channel. The bot starts
a thread and replies there. Inside any thread under an allowed parent channel,
your text messages are addressed to the bot without a mention. The first message
attaches a session, and subsequent messages continue it. Each thread keeps its own history and selected model
across worker restarts, renames, and archiving. Start a new thread for a new
session. Earlier messages in an existing thread are not imported.

The bot shows Discord's typing indicator while working, including during tool
calls. It refreshes every eight seconds and stops refreshing when the request
finishes, fails, or is cancelled. Discord clears it after a reply or within ten
seconds of the last refresh. Indicator failures do not interrupt the request.

In an attached thread, `@Poppet /status` reports its session and latest run;
`@Poppet /cancel` interrupts its active request and cancels its queued requests.
These are text messages, not registered Discord slash commands. The bot ignores
other users, bots, and webhooks. DMs, forums, attachments, voice, and streaming
message edits are not supported in this phase.

Use `bun run start gateway status` for connection state, rejected/dropped event
counts while running, and persisted queue/delivery counts. Completed answers
are saved before sending; a delivery retry never repeats model or tool work.
Uncertain sends are recorded without automatic resending, since Discord may
already have posted them. Use the session ID and `chat show <session>` to inspect
the saved answer before manually reposting it. No reply is redirected to another
channel when a thread becomes inaccessible. Telegram, WhatsApp, and scheduled
result delivery remain planned work.

Automated tests use injected Discord events and API responses. Live bot setup,
permissions, reconnection, and model inference still need manual validation.

## ChatGPT connection

Sign in through the system browser, then verify subscription access:

```fish
bun run start auth login openai-chatgpt
bun run start auth models openai-chatgpt
bun run start auth verify --provider openai-chatgpt
bun run start auth status openai-chatgpt
```

Initial sign-in registers Poppet with its own host identifier and issued client
ID. The browser handles account and workspace selection and plan-usage consent.
The local callback displays a confirmation page before its listener closes.
Return to the terminal for the final identity and permission checks.
Later sign-ins reuse the registration and host identifier until logout. The next
login after logout creates a fresh registration and host identifier. Poppet currently stores
one account and rejects a returning identity that does not match it until logout.
[OpenAI registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)

`auth verify` selects the first visible model in the account's catalog. Pass a
model slug from `auth models` to choose another, for example
`bun run start auth verify <slug> --provider openai-chatgpt`. Verification makes two streamed Responses
requests, which consume ChatGPT plan usage. It requests a local tool, supplies a
random token as the tool result, and requires the completed answer to return that
token. Success records the model and verification time; it does not guarantee
future quota or eligibility.
[Subscription inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

If identity sign-in succeeds without plan-usage permission, status reports
`planUsage: false`. Run `bun run start auth login openai-chatgpt --consent` to request consent
again. Usage limits, ineligible accounts, temporary failures, and interrupted
streams produce separate errors. Model requests are not automatically retried.
The flow uses OAuth credentials and requires no API key or client secret.

Credentials live in `<POPPET_DATA_DIR>/auth/connection.json`, with owner-only file
permissions (`0600`) inside a protected directory (`0700`). Writes use atomic
replacement. Tokens are redacted in application values and omitted from command
output. Near-expiry access tokens are refreshed with rotating credentials saved
together. An exclusive `auth/owner.lock` prevents concurrent authentication
commands and is removed on normal shutdown or interruption. After a process
crash, remove a remaining lock only after confirming no Poppet auth command is
running.

`bun run start auth logout openai-chatgpt` deletes the saved connection file,
including account identity, tokens, verification, registration, and host identifier,
then attempts remote revocation. Status does not recreate those details.
Other providers' credentials are preserved. If remote revocation cannot
be confirmed, the command reports this so you can disconnect Poppet in ChatGPT
Settings.

## Configured providers and models

Select a provider and an explicit model. Auth commands default to `POPPET_PROVIDER`.
Pass a provider after `login`, `status`, `models`, or `logout`, or use
`--provider <id>` for any auth command. This selects which credentials to manage
without changing the configured inference provider. Login and status work before
model selection. General provider commands use the configured provider:

```fish
set -lx POPPET_PROVIDER openai-chatgpt
set -lx POPPET_MODEL gpt-6.1-sol
bun run start provider models
bun run start provider verify
```

`provider verify` exercises the shared message and continuation contract with
two requests and a local tool round trip. It consumes provider usage. A model
must be selected before verification opens credentials. The runtime builds only
the selected provider's dependencies and never falls back to another model.

For OpenCode Go, discovery uses its public catalog without an API key. Log in
with a hidden key prompt, then select a model:

```fish
set -lx POPPET_PROVIDER opencode-go
set -lx POPPET_MODEL glm-5.3
bun run start auth login opencode-go
bun run start provider models
bun run start provider verify
```

The initial Go adapter supports `gpt-6-luna` through Responses and `glm-5.3`
through Chat Completions. Discovery lists those models when they appear in the
remote catalog. Other Go models, including the Messages protocol, are not yet
supported. Both protocols send `poppet/0.0.0` and a stable `x-opencode-session`
header for the exchange.

Go documents coding-agent traffic. Poppet's Go adapter requires a `coding`
workload and rejects general assistant, notes, and scheduled-summary requests
before reading its key or making inference requests.
[OpenCode Go requirements and endpoints](https://opencode.ai/v2/docs/console/go/)

For OpenRouter, discovery uses its public catalog without an API key. Select a
concrete model ID and save a key through login:

```fish
set -lx POPPET_PROVIDER openrouter
bun run start provider models
set -lx POPPET_MODEL anthropic/claude-sonnet-4.5
bun run start auth login openrouter
bun run start provider verify
```

API-key login saves credentials under `<POPPET_DATA_DIR>/auth/openrouter.json`
or `opencode-go.json`, with `0600` file permissions inside a `0700` directory.
Writes replace files atomically and use a separate lock for each provider.
Login reads an existing environment key if set, otherwise prompts without echo.
For scripts, `auth login openrouter --key-stdin` reads a key from standard input;
keys are never accepted as command-line arguments.

`POPPET_OPENROUTER_API_KEY` and `POPPET_OPENCODE_GO_API_KEY` override stored keys
for inference and status. Empty or invalid overrides fail instead of falling
back to a stored key. Status reports the credential source without secrets;
remote access is checked separately by verification. `auth logout openrouter`
removes that provider's saved key. It leaves other providers connected and does
not revoke the remote key or unset an environment override.

To verify a provider without changing `POPPET_PROVIDER`, use
`bun run start auth verify <model-id> --provider openrouter`. ChatGPT's browser
login and `--consent` remain available through `auth login openai-chatgpt`.

Verification requires a catalog model with tool support and makes two requests
that consume OpenRouter credits. The key is redacted and omitted from `config`.
The adapter accepts both assistant and coding workloads through Chat Completions.
It derives tools, temperature, output limits, and context size from catalog
metadata. Models that generate images or audio and dynamic model routers such as
`openrouter/auto` and `openrouter/free` are excluded.

Requests require support for every requested parameter and disable provider
fallbacks. A stable `session_id` groups the exchange. Plain reasoning and the
complete structured reasoning sequence survive tool calls. Credit exhaustion,
rate limits, upstream failures, and interrupted streams produce typed errors;
requests are not automatically retried.
[OpenRouter routing](https://openrouter.ai/docs/guides/routing/provider-selection),
[reasoning continuation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens),
and [stream errors](https://openrouter.ai/docs/api/reference/streaming).

Local tests cover all providers' text and tool exchanges, reasoning
continuation, output ordering, malformed and incomplete streams, cancellation,
deadlines, error classification, and provider selection. These tests do not prove
live account access. The earlier phase 1 live ChatGPT check remains separate
evidence; Go and OpenRouter inference have not been verified against live accounts.

## Chat

After signing in and choosing a model, start a session:

```fish
set -lx POPPET_PROVIDER openai-chatgpt
set -lx POPPET_MODEL gpt-6.1-sol
bun run start chat new "Help me plan a small TypeScript project"
bun run start chat sessions
```

The answer streams to stdout. The session and run IDs print to stderr. Copy the
session ID to continue or inspect it in a later invocation:

```fish
set session_id 'paste-session-id-here'
bun run start chat send $session_id "What should I build first?"
bun run start chat show $session_id
```

Each invocation sends one message. `chat sessions` lists saved sessions;
`chat show` prints the session, ordered messages, run states, failures, output,
and usage as JSON. Opaque provider continuation is retained privately in SQLite
and omitted from this display. Inspection needs no selected model or login.

New sessions use `POPPET_PROVIDER` and the required `POPPET_MODEL`. Existing
sessions keep their saved provider, model, and workload when configuration
changes. Start a new session to change that selection. OpenCode Go requires a
coding session:

```fish
set -lx POPPET_PROVIDER opencode-go
set -lx POPPET_MODEL glm-5.3
bun run start chat new --coding "Explain how to structure a TypeScript CLI"
```

Poppet saves each input before resolving its model. Only an authoritative
completed response becomes a saved answer. Provider failures, context errors,
Ctrl-C, closed output, and deadlines leave inspectable failed or interrupted
runs. Partial output may already be visible in the terminal but is not saved as
an answer. Failed inputs remain visible and are excluded from subsequent model
context; sending another message is an explicit new request. Requests are never
automatically retried or switched to another provider/model.

Context retains recent complete exchanges, including tool pairs and continuation,
up to the configured turn and byte budgets. When model capacity is known,
Poppet also reserves room for output and request overhead. UTF-8 bytes are a
conservative estimate rather than an exact tokenizer; providers can still reject
oversized context. A new message that cannot fit fails clearly. Trimming changes
only the request, not saved history. Answers are limited to 128 KiB of text and
1 MiB including continuation. The runner has a 90-second absolute deadline;
provider inference also retains its 60-second deadline.

Tool-capable models receive the three notes tools below. Models without tool
support continue to answer text requests. The runner checks complete tool
requests before execution and keeps one provider/model throughout the exchange.
Recorded usage sums all model turns when every turn reports usage, otherwise it
is null. Live account chat remains a manual check and consumes provider usage.

## Notes tools

`read_note`, `search_notes`, and `save_note` operate within `POPPET_NOTES_DIR`.
Use UTF-8 `.md`, `.markdown`, or `.txt` files. Relative paths are preferred;
absolute paths must remain within the canonical notes directory. Root, parent,
and file symlinks are rejected, as are hard-linked files. Searches skip symlinks.

Try the complete flow with an existing notes directory and a tool-capable model:

```fish
set -lx POPPET_NOTES_DIR "$HOME/Documents/Notes"
bun run start chat new "Find notes about Acorn, read them, and save a summary as acorn-summary.md."
```

Saving creates or atomically replaces a note. Existing content is replaced, so
include the intended path in your request. New files have owner-only permissions;
checked parent directories are created as needed. Each note write is limited to
64 KiB of UTF-8 text. Reads scan at most 64 KiB per note and explicitly report
truncation. Search uses literal case-insensitive text, returning relative paths,
line numbers, and snippets. It scans at most 128 files and 128 directories,
returns at most 100 matches, and rejects directories exceeding 1000 entries.
The per-tool result budget can truncate read/search results further.

Runs default to eight model turns and sixteen tool calls. Every requested batch
is checked against the run's allowed tools and argument schemas before any call
in that batch executes. A batch is not executed unless another model turn remains
to consume its results. Tool results and definitions count toward context size;
the current exchange is kept whole and fails if it cannot fit. The 90-second
run deadline includes all model turns and tools. The 128 KiB text limit applies
across all turns, and each serialized completion is limited to 1 MiB.

Inputs, complete tool requests, execution states, and results are saved in SQLite.
`chat show` includes a `toolCalls` list. Results are recorded atomically with their
transcript messages. Graceful cancellation waits for an in-flight save and its
result recording before stopping. On reopening, queued calls become interrupted
and started calls without recorded results become uncertain. A write can succeed
before its result is saved; inspect the file before manually retrying an uncertain
write. Failed or interrupted exchanges remain inspectable and are excluded from
later model context. Calls and writes are never automatically replayed.

Local tests cover the full note flow,
boundaries, limits, cancellation, and uncertain outcomes. They use injected models
and do not establish fresh live provider access.

## Explicit memory

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

Edit `<POPPET_DATA_DIR>/profile.md` for your name, background, and preferences.
With the default data directory, this is `~/.config/poppet/profile.md`. A missing
profile is empty and is never created automatically. Existing profiles must be
regular UTF-8 files; profile symlinks are rejected.

Every chat run reads the current profile and saved facts once, then keeps that
snapshot across its model/tool turns. New sessions and resumed sessions pick up
changes on their next run. Memory is shared across sessions and providers in the
same data directory. Facts are included in key order as personal context, with no
provenance metadata sent to the model. Chat has no memory-writing tool and does
not infer or automatically save facts from conversations.

`@poppet/memory` provides a `Memory` service for snapshots and fact management.
The CLI supplies `LocalMemoryLive`, backed by the existing SQLite database and
profile file. The agent consumes the service and formats its snapshot into model
instructions. A future implementation can replace the memory layer at the CLI
boundary without changing the agent loop or command behavior.

Profile and fact budgets default to 8 KiB each. Oversized memory fails clearly
instead of silently omitting preferences. Both count toward `POPPET_CONTEXT_BYTES`
alongside instructions, tool definitions, and history. A malformed or oversized
profile or facts block fails before resolving a provider; a context overflow fails
before inference. Forgetting removes the saved fact from future snapshots; existing
conversation messages and note files remain in their own storage.

## Conversation storage

Open or inspect the local database:

```fish
bun run start store status
```

This opens `<POPPET_DATA_DIR>/store/poppet.sqlite`, applies pending migrations,
and prints its path, schema version, and session/message/run counts. It requires
no login or selected model. Help, configuration, and auth commands do not open
this database. To experiment in a separate directory:

```fish
set -lx POPPET_DATA_DIR /tmp/poppet-storage-test
bun run start store status
```

Migration 4 adds durable tool calls and their execution states. Migration 5 adds
explicitly saved facts in `memories`.

`@poppet/store` provides a scoped Effect `Store` service backed by
[Bun SQLite](https://bun.sh/docs/runtime/sqlite). The initial migrations create
sessions, messages, runs, and history indexes. A checksummed migration ledger
rejects newer schemas and changed migration history. All pending migrations
commit together; a failure rolls back the pending batch.

Sessions retain their selected provider, model, and workload. Migration 3 adds
workload to sessions and runs, defaulting existing records to `assistant`.
Messages preserve order, tool
call IDs, tool results, and versioned provider continuation. Runs persist pending
inputs before execution, then transition through running to completed, failed,
or interrupted. Successful completion writes its assistant message and result
in one transaction. The store validates continuation identity on write and read.
It permits one pending or running run across all sessions.

The store directory uses `0700` permissions; the database and WAL sidecars use
`0600`. Credentials stay in the separate `auth` directory. The store holds an
exclusive ownership until its SQLite connection closes, including on interruption
and initialization failure. A shared helper uses an OS-held SQLite lock in
`store/owner.lock.sqlite` and an atomic PID marker in `store/owner.lock`.
A dead owner is recovered automatically. Unknown legacy markers still require
manual removal after confirming no old Poppet process owns the storage.
Never remove a `.lock.sqlite` file while Poppet is running. These small lock
databases contain no credentials and remain after logout. On reopening, unfinished runs become interrupted
with a `process-exit` reason. Poppet does not automatically replay them.

Tests cover persistent tool exchanges for all providers, upgrades and migration
rollback, transaction rollback, invalid records, run transitions, competing
owners, and scoped cleanup. Live ChatGPT token renewal
remains a separate phase 3 follow-up.

## Scheduled tasks

Select a provider and model as for chat, and sign in before running a task.
Tasks save that selection when added. The worker uses each saved selection even
if its environment selects a different model later.

For a quick test, create a note in `POPPET_NOTES_DIR`, then schedule its summary
one minute from now:

```fish
set when (bun -e 'console.log(new Date(Date.now() + 60_000).toISOString())')
bun run start tasks add summary --at $when "Read project.md and summarize it"
bun run start tasks work
```

The worker prints timestamped lifecycle messages for starts, completed or failed
runs, interruptions, cancellation, skipped intervals, and task/provider pauses and
resumes. Occurrence messages include the task name and occurrence ID. Failures use
reason codes; prompts, note contents, and model answers stay in saved results.
An idle worker does not print polling messages.

Leave the worker running. In another terminal using the same `POPPET_DATA_DIR`:

```fish
bun run start tasks list
bun run start tasks show <task-id>
bun run start tasks pause <task-id>
bun run start tasks resume <task-id>
```

Use a five-field cron expression and explicit timezone for a recurring task:

```fish
bun run start tasks add daily-summary --cron "0 9 * * *" --tz Europe/London "Summarize my notes"
```

One-off timestamps require `Z` or an explicit UTC offset. Cron schedules retain
local wall time across timezone changes. A missing local time during spring DST
shifts forward; a repeated time during autumn DST runs once. The database stores
times as UTC milliseconds. `show` includes final answers, run/session IDs, failures,
and skipped intervals. Each occurrence has a fresh session, current profile and
facts, and only `read_note` and `search_notes`. A returned `save_note` call is rejected.
Use `--coding` before the prompt only for coding work that the chosen provider accepts.

The worker executes one occurrence at a time. Recurring times missed while stopped
are skipped. An overdue one-off runs once. A recurring task keeps at most one pending
or running occurrence; additional due times are recorded as skipped intervals.
Pending recurring summaries expire after 24 hours. One-off work never expires.
Pausing cancels pending work and keeps previous results. An active run needs an
explicit cancellation:

```fish
bun run start tasks cancel <occurrence-id>
bun run start tasks retry <occurrence-id>
bun run start tasks providers
bun run start tasks resume-provider openai-chatgpt
```

Quota failures pause scheduled requests for that provider until `resume-provider`.
Temporary and rate-limit failures delay subsequent work by 30 seconds, doubling
after further failures up to five minutes. A failed occurrence is never retried
automatically. `retry` creates a fresh session for an unsuccessful occurrence;
earlier runs remain available through chat inspection. Resume a paused task before
retrying it. A cancelled one-off needs `retry`, since it has no future occurrences.

To remove every task and its occurrence/skip history:

```fish
bun run start tasks clear
```

This works with the worker running or stopped. A running worker interrupts active
work before clearing and continues serving commands. Saved chat sessions and runs,
notes, facts, credentials, and provider quota pauses are retained. The command
returns the number of tasks removed, and repeating it on an empty list is safe.

`@poppet/tasks` owns scheduling, task persistence, recovery, and the worker socket.
The CLI parses arguments, prints results, and composes the live layers.

`tasks work` owns SQLite and serves task, chat, memory, and store-status commands
through `store/tasks.sock`, protected by the `0700` store directory and `0600`
socket. Commands use the worker when it is running and execute locally when it
is stopped. Inspecting saved data needs no model or provider credentials.
Interactive and scheduled model requests share one runner. Chat streams to the
invoking terminal; Ctrl-C cancels that request and leaves the worker running.
Stopping the worker interrupts active requests and releases the socket and owner lock. After a crash,
a new owner automatically reclaims storage from a dead process; unfinished work
needs an explicit retry. Already queued work survives restart, and a committed
answer is recovered without repeating its request. Task commands can open the
store even if a dead worker left its socket behind. A lost response to a delivered command does
not trigger local fallback. Task outcomes and provider pauses commit together;
recovery restores a quota pause from an unfinished occurrence's saved run.

## Background worker

On macOS, stop any foreground worker, then install a user LaunchAgent to start
the existing task worker at login and keep it running while you are logged in:

```fish
bun run start worker install
bun run start worker status
bun run start worker logs
```

Installation starts it immediately. It records the absolute Bun executable, CLI
entry point, current working directory, validated configuration paths, and any
explicit chat budgets. Keep that checkout and Bun executable in place. To change
saved settings or move the checkout, uninstall and install again. Each data
directory has its own launch agent. Manage it with the same `POPPET_DATA_DIR`.

API keys are excluded from the launch agent's environment. Save them first with
`auth login openrouter` or `auth login opencode-go`; ChatGPT uses its existing
protected sign-in storage. The worker refreshes credentials through the same
provider code as chat. Installation does not verify live inference.

`worker status` reports whether the launch agent is installed and loaded, whether
the worker is responding, its PID and active occurrence, task and pending counts,
the next scheduled timestamp, provider pauses, and five recent outcomes. It also
shows local connection metadata and the account and plan-usage permission where
supported, with actions for login, consent, quota resume, and failed work.
Running and stopped status include providers assigned to saved tasks, even when
the current CLI default provider differs.
Connection metadata is not a live provider verification. During an active
credential-owning request, the last observed metadata is labelled `cached` with
its observation time. `tasks status` works for the foreground worker too.

Inspect full task results using the existing commands:

```fish
bun run start tasks list
bun run start tasks show <task-id>
```

Lifecycle logs go to `<data directory>/logs/worker.log`, with `0700` directory and
`0600` file permissions. They exclude prompts, notes, model output, and tokens.
`worker logs` prints at most the last 64 KiB. Log rotation is not implemented;
remove or truncate old logs while the worker is stopped if needed.

```fish
bun run start worker stop
bun run start worker start
bun run start worker uninstall
```

Stopping removes the running launchd registration and sends SIGTERM. Scoped
cleanup interrupts active work, records its outcome, closes the socket, and
releases storage. `stop` keeps login startup configured; `uninstall` disables it
and retains tasks, results, notes, credentials, and logs. Inspection errors fail
the command and preserve the installed configuration. Lifecycle mutations finish
before an interruption returns; each launchctl subprocess has a 35-second timeout.
Starting an already
loaded worker does not interrupt an active request. Chat, memory, session
inspection, and `store status` work while it is running:

```fish
bun run start memory remember project.name Acorn
bun run start chat new "What is the project called?"
bun run start chat sessions
bun run start memory list
bun run start store status
```

New chats use the invoking terminal's provider, model, and workload; continued
chats use their saved selection. The worker's saved notes directory and budgets
apply to remote requests. Memory changes are loaded on the next run. Chat output
and session IDs go to the client terminal and are excluded from worker logs.
Request bodies have a 10-second read deadline and a 2 MiB transport limit,
which leaves room for the supported 1 MiB serialized chat context and command
metadata. Oversized requests report a size error without being retried.
Only an absent socket or refused connection permits local fallback. A lost,
incomplete, or incompatible response fails without replaying the command. Restart
an older worker with `worker stop` followed by `worker start` after updating code.

The worker does not keep the Mac awake. After sleep, it runs an overdue one-off
once. For a delayed recurring task, it runs the earliest due occurrence once and
records later missed occurrences as skipped. Summaries older than 24 hours expire.
Restart skips recurring work missed while the process was stopped. Failed or
interrupted requests are never automatically replayed.

To manually test background execution with your configured provider and model:

```fish
set when (date -u -v+1M +%Y-%m-%dT%H:%M:%SZ)
bun run start tasks add background-summary --at $when "Read project.md and summarize it"
bun run start worker install
bun run start worker status
# After the scheduled time, inspect the task ID returned by tasks add:
bun run start tasks show <task-id>
bun run start worker logs
```

Use `worker start` instead of `install` if it is already installed. Repeat with a
sleep/wake cycle, then stop/start the worker and confirm a completed occurrence
does not run again. Automated tests simulate clock jumps, crash recovery, and
SIGTERM cleanup. Actual login startup, physical sleep/wake, and live provider
execution remain manual checks. Other platforms can use `tasks work` in the
foreground; background installation currently supports macOS only.

## Adding a provider

Each provider exports a `ProviderRegistration` from its own workspace package.
Register it in `apps/cli/src/providers.ts` and declare its CLI workspace dependency.
The registration supplies the ID, display name, authentication capabilities, help,
and complete live layer. Configuration defaults to the first registered provider.

The CLI consumes shared `Provider`, `Model`, and `ProviderConnection` services.
Provider packages own authentication, environment-variable names, protocol choice,
headers, continuation extensions, and error rules. Shared credentials and protocol
helpers receive these settings from their owner. Adding a provider needs no changes
to shared schemas, storage, or command routing. Lint enforces the import boundary.
See [provider registration and ownership](docs/architecture.md#provider-registration-and-ownership)
for the contract and integration steps.

`auth models` now returns normalized model descriptions for every provider,
including ChatGPT. Wire protocol names are internal and omitted from those descriptions.
Existing credential files and conversation records keep their formats.

## Source layout

```text
apps/
  cli/                    @poppet/cli
    src/
      main.ts             Bun process entry point and Effect runtime
      cli.ts              Command routing and terminal output
      chat.ts             Chat commands, streaming output, session inspection
      runtime.ts          Generic selection and host configuration layers
      providers.ts        Provider registrations; first entry is the default
      tasks.ts            Task argument parsing
      worker.ts           Worker argument parsing, launch settings, and platform selection
      worker-commands.ts  Interactive command transport and host request handling
packages/
  agent/                  @poppet/agent
    src/service.ts        Persisted chat runner, deadlines, run finalization
    src/conversation.ts   Sequential model/tool loop and run budgets
    src/reply.ts          Validated model stream completion
    src/notes.ts          Note schemas, bounded access, atomic writes
    src/memory.ts         Memory snapshots formatted into model instructions
    src/context.ts        Complete-exchange context assembly and limits
    src/settings.ts       Validated chat budgets
  config/                 @poppet/config
    src/config.ts         Validated settings and AppConfig service/layer
  credentials/            @poppet/credentials
    src/api-keys.ts       Protected API-key storage and environment overrides
    src/lock.ts           Scoped ownership shared by credentials and SQLite storage
  memory/                 @poppet/memory
    src/service.ts        Memory service and domain errors
    src/schema.ts         Facts, snapshot data, and snapshot limits
    src/local.ts          Local fact operations and bounded snapshots
    src/profile.ts        Bounded UTF-8 profile reads
  store/                  @poppet/store
    src/database.ts       Scoped SQLite connection, ownership, and permissions
    src/migrations.ts     Versioned schema and transactional migration ledger
    src/schema.ts         Durable session, message, and run schemas
    src/service.ts        Validated record operations and run lifecycle
  tasks/                  @poppet/tasks
    src/scheduler.ts      Serialized scheduled runs and wake queue
    src/commands.ts       Task operations and result inspection
    src/task-store.ts     Durable scheduling and occurrence transitions
    src/task-schema.ts    Typed commands, cron expressions, and timestamps
    src/task-socket.ts    Protected local commands for the worker
  platform/               @poppet/platform
    src/index.ts          Worker actions, errors, and launch description
  platform-macos/         @poppet/platform-macos
    src/worker.ts         LaunchAgent control, plist generation, and bounded log reading
  provider/               @poppet/provider
    src/schema.ts         Normalized messages, tools, events, and continuation
    src/service.ts        Provider and selected Model services, typed errors
    src/verification.ts   Shared local tool round-trip verification
    src/registration.ts   Connection interface, provider metadata, and host services
  provider-protocol/      @poppet/provider-protocol
    src/                  Reusable Responses/Chat Completions codecs and cancellation
  provider-openai/        @poppet/provider-openai
    src/
      index.ts            Public services, live layers, and connection errors
      connection.ts       Credential schemas and redacted secrets
      auth/               Login, refresh, status, protected credential storage
      oauth/              Discovery, token exchange, JWT identity validation
      sign-in/            Browser sign-in and scoped loopback callback
      model/              Model catalog, subscription errors, verification
      registration.ts     Provider-owned live composition and connection operations
      test/fixtures/      Local OAuth and model servers for behavior tests
  provider-opencode/      @poppet/provider-opencode
    src/service.ts        Go catalog, secret configuration, and protocol routing
    src/protocol.ts       Go session headers and reasoning continuation
  provider-openrouter/    @poppet/provider-openrouter
    src/service.ts        OpenRouter catalog, capabilities, and secret configuration
    src/protocol.ts       Routing, reasoning continuation, and stream error rules
docs/
  architecture.md  Service boundaries and Effect conventions
  implementation-plan.md
tools/
  oxlint/anti-slop/        Vendored lint rules
```

Each workspace declares its own dependencies. Imports between workspaces use
package names and their explicit exports. Internal imports use `#src/*`, mapped
to `./src/*.ts` by each workspace's `package.json`. For example,
`#src/auth/service` resolves to that workspace's `src/auth/service.ts`.
Shared TypeScript options live in `tsconfig.base.json`. Formatting,
linting, CI, and the lockfile remain at the root.

Auth tests use a local OAuth server with signed test identities and fake model
streams. Tests sit beside each capability. Provider suites share fixtures under
`packages/provider-openai/src/test/fixtures`.
They do not access a ChatGPT account. Storage tests use temporary SQLite databases.
See the
[architecture notes](docs/architecture.md) for the service boundaries.

## Licence

BSD 3-Clause. See [LICENSE](LICENSE).
