# Configuration

[Documentation index](README.md)

Use [`poppet doctor`](doctor.md) to inspect setup and worker state without
repairs or live provider/tool probes.

## Configuration file

Keep ordinary settings in `~/.config/poppet/config.json`. The file and every
field are optional. To use another data directory, set `POPPET_DATA_DIR` before
running any Poppet command. Credentials stay in protected files outside this file.

Run `poppet setup` to choose a provider and model, optionally configure Discord and Slack,
and offer worker startup. It preserves settings outside those choices. See
[`poppet setup`](cli.md#configuration-and-storage) for the interactive flow.

A minimal configuration is:

```json
{
  "provider": "openai-chatgpt",
  "model": "replace-with-model-id"
}
```

Use `poppet provider models <provider>` to find a model ID. Login saves credentials;
it does not select a default provider or model. Existing chats and tasks keep their
saved selections when you change these defaults. Explicit command arguments take
precedence where supported.

`poppet config` validates and prints the invoking process's settings, config-file
location, and whether `POPPET_DATA_DIR` is set. It does not open storage, load
credentials, contact providers, or inspect a running worker. Restart the worker
after editing settings: `poppet worker restart`.

## Settings

| Field                        | Default          | Purpose                                                                                         |
| ---------------------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| `provider`                   | `openai-chatgpt` | Default provider for new chats and tasks                                                        |
| `model`                      | Unset            | Required model ID for new chats and tasks                                                       |
| `applicationName`            | `Poppet`         | Name used during initial ChatGPT registration                                                   |
| `timeZone`                   | Unset            | Your IANA time zone; see [time zone](#time-zone)                                                |
| `discord`                    | Unconfigured     | Owner ID, guild ID, and home channel ID                                                         |
| `slack`                      | Unconfigured     | Owner ID, team ID, and home channel ID                                                          |
| `mcpServers`                 | `[]`             | [MCP servers, sign-in, and tool permissions](mcp.md)                                            |
| `gatewayPackages`            | `[]`             | Explicitly installed [external gateway packages](development.md#adding-a-gateway)               |
| `tasks.catchUpMinutes`       | `60`             | Missed recurring-job window, from 0 to 1440 minutes                                             |
| `tasks.quietHours`           | Unset            | Daily window when scheduled messaging posts wait; see [quiet hours](#quiet-hours)               |
| `chat.outputTokens`          | `2048`           | Requested output limit, from 1 to 32768, capped by model metadata                               |
| `chat.runDeadlineSeconds`    | `300`            | Overall run deadline, from 30 to 3600 seconds                                                   |
| `chat.logReasoning`          | `false`          | Show saved reasoning in CLI diagnostics and worker logs                                         |
| `chat.logTimings`            | `false`          | Log request-stage durations                                                                     |
| `chat.maxConcurrentRequests` | `3`              | Chat requests that run at once across messaging, CLI, web chat, and scheduled runs, from 1 to 8 |

`chat.maxConcurrentRequests` above 1 lets different Discord and Slack conversations and
sessions run at the same time; requests to one session or one conversation stay
in order. Set it to 1 to answer one request at a time. Simultaneous
`openai-chatgpt` requests in the worker share one credential lock and refresh an
expiring token once; `provider login` and `logout` in another terminal report the
store as busy until no request is running. A provider rate limit fails the request
with the standard failure reply rather than retrying. A request waiting for command approval keeps its slot until the approval expires
(`timeouts.approvalSeconds`, two minutes by default).

Timeouts and size limits live in the `timeouts` and `limits` sections; see
[timeouts and limits](#timeouts-and-limits). `poppet config` prints every resolved value.

The file must be valid JSON, at most 64 KiB, owned by the current user, and not
writable by group or other users. Symlinks and hard links are rejected. Unknown
keys, incorrect types, and invalid values fail clearly. Text values must be
nonempty and trimmed. Relative MCP working-directory paths
resolve beside `config.json`; bare executable names use `PATH`. Literal `~` is not expanded.

## Time zone

Set `timeZone` to your IANA time zone name so Poppet knows your local time:

```json
{
  "timeZone": "Europe/London"
}
```

Chats that can schedule tasks then see the local date and time, and the agent
uses this zone for task times you give without an offset or zone instead of
asking. `poppet tasks add` and `tasks edit` use it when `--cron` is given without
`--tz`, and [quiet hours](#quiet-hours) use it when they set no `timeZone` of
their own. One-off `--at` timestamps still need an explicit offset. Unknown zones and UTC offsets such as `+01:00` are
rejected. Restart the worker after changing it.

## Timeouts and limits

Each field is optional and takes a whole number. Timeouts are in seconds; `Bytes` fields are
UTF-8 or raw bytes. Values outside the range fail validation like any other invalid setting.
Restart the worker after changing them.

```json
{
  "timeouts": { "inferenceSeconds": 180, "pageFetchSeconds": 30 },
  "limits": { "toolBytes": 32768, "historyTurns": 40 }
}
```

| Field                                | Default | Range   | Purpose                                                                                |
| ------------------------------------ | ------- | ------- | -------------------------------------------------------------------------------------- |
| `timeouts.inferenceSeconds`          | 60      | 5–3600  | Absolute deadline for one model inference request                                      |
| `timeouts.providerRequestSeconds`    | 45      | 5–3600  | HTTP timeout for OpenAI-compatible provider requests                                   |
| `timeouts.modelCatalogSeconds`       | 30      | 1–300   | Provider model-list request                                                            |
| `timeouts.modelCatalogCacheSeconds`  | 60      | 0–86400 | How long a fetched model list is reused; 0 refetches every time                        |
| `timeouts.actionReviewSeconds`       | 30      | 1–600   | Automatic review of a Bash command or MCP action                                       |
| `timeouts.sessionTitleSeconds`       | 10      | 1–300   | Generating a chat session title                                                        |
| `timeouts.conversationNamingSeconds` | 10      | 1–300   | Renaming a Discord or Slack conversation                                               |
| `timeouts.pageFetchSeconds`          | 15      | 1–300   | Reading a public page, including redirects                                             |
| `timeouts.mcpConnectSeconds`         | 5       | 1–300   | Connecting to an MCP server and each tool-list request                                 |
| `timeouts.mcpStartupSeconds`         | 8       | 1–600   | Starting an MCP server, including discovery                                            |
| `timeouts.mcpToolCallSeconds`        | 10      | 1–3600  | One MCP tool call                                                                      |
| `timeouts.taskOperationSeconds`      | 8       | 1–300   | Creating or changing a task through the worker, and checking its messaging destination |
| `timeouts.approvalSeconds`           | 120     | 10–3600 | How long an approval request stays open                                                |
| `timeouts.attachmentDownloadSeconds` | 30      | 1–600   | Downloading one messaging attachment                                                   |
| `timeouts.gatewayRequestSeconds`     | 10      | 1–300   | Discord, Slack, and Telegram API requests                                              |
| `timeouts.gatewayRetrySeconds`       | 30      | 1–3600  | Wait before a messaging adapter reconnects after a failure                             |
| `timeouts.gatewayRestartMaxSeconds`  | 300     | 1–3600  | Longest wait between messaging adapter restarts                                        |
| `timeouts.telegramPollSeconds`       | 30      | 1–50    | Telegram long-poll duration                                                            |

| Field                            | Default | Range          | Purpose                                                          |
| -------------------------------- | ------- | -------------- | ---------------------------------------------------------------- |
| `limits.contextBytes`            | 256 KiB | 16 KiB–16 MiB  | Context budget per model request                                 |
| `limits.historyTurns`            | 20      | 1–200          | Recent exchanges kept in context                                 |
| `limits.modelTurns`              | 16      | 1–128          | Model turns per run                                              |
| `limits.toolCalls`               | 16      | 1–256          | Tool calls per run                                               |
| `limits.toolBytes`               | 16 KiB  | 1 KiB–64 KiB   | Size of one tool result                                          |
| `limits.soulBytes`               | 8 KiB   | 1–64 KiB       | `soul.md` size                                                   |
| `limits.profileBytes`            | 8 KiB   | 1–64 KiB       | `profile.md` size                                                |
| `limits.skillIndexBytes`         | 8 KiB   | 0–64 KiB       | Skill index size; 0 turns the index and skill tools off          |
| `limits.skillIndexEntries`       | 64      | 1–512          | Skills considered for the index                                  |
| `limits.skillDescriptionBytes`   | 240     | 16–4 KiB       | Size of one skill description in the index                       |
| `limits.skillMentions`           | 4       | 0–32           | `$skill` mentions in one message                                 |
| `limits.attachmentsPerMessage`   | 4       | 0–10           | Files attached to one message                                    |
| `limits.imageBytes`              | 5 MiB   | 1 KiB–20 MiB   | Size of one image attachment                                     |
| `limits.textFileBytes`           | 64 KiB  | 1 KiB–1 MiB    | Size of one text attachment                                      |
| `limits.imagesPerRequest`        | 8       | 0–64           | Images sent in one model request                                 |
| `limits.imageContextBytes`       | 6 KiB   | 1 KiB–64 KiB   | Context budget counted for each image                            |
| `limits.replyTextBytes`          | 128 KiB | 4 KiB–4 MiB    | Answer text, and logged reasoning, per run                       |
| `limits.completionBytes`         | 1 MiB   | 16 KiB–16 MiB  | Serialized completion, including continuation                    |
| `limits.pageBytes`               | 1 MiB   | 64 KiB–16 MiB  | Transferred and decoded page body                                |
| `limits.mcpTools`                | 128     | 1–1024         | Tools discovered from one MCP server                             |
| `limits.mcpDiscoveryBytes`       | 256 KiB | 16 KiB–4 MiB   | Tool-list JSON from one MCP server                               |
| `limits.tasks`                   | 64      | 1–1024         | Saved tasks                                                      |
| `limits.chatTaskCreatesPerRun`   | 5       | 0–64           | Tasks one chat run can create                                    |
| `limits.chatTaskIntervalMinutes` | 5       | 1–1440         | Shortest interval for a recurring task created or edited in chat |
| `limits.workerLogBytes`          | 5 MiB   | 64 KiB–256 MiB | Size of each background worker log file before rotation          |
| `limits.webChatBodyBytes`        | 256 KiB | 64 KiB–16 MiB  | Web chat request body                                            |
| `limits.webChatStreams`          | 32      | 1–256          | Open web chat event streams                                      |

Larger attachment limits raise the worker request-body limit to match. The saved-facts budget,
skill-file size, task note and prompt sizes, the Bash tool's 300-second ceiling, and messaging
platform message lengths stay fixed: they are part of stored data or of contracts with the model
and messaging platforms.

## Quiet hours

Set `tasks.quietHours` to hold scheduled posts to Discord and Slack overnight:

```json
{
  "tasks": {
    "quietHours": { "start": "22:00", "end": "07:30", "timeZone": "Europe/London" }
  }
}
```

Times are 24-hour `HH:MM` wall-clock times in the IANA `timeZone`. Omit it to
use the top-level [`timeZone`](#time-zone); one of the two is required. A window can
cross midnight. `start` and `end` must differ; invalid times, unknown zones, and
UTC offsets such as `+01:00` are rejected. Without the setting nothing is held.

Scheduled results and [failure notices](tasks.md#failure-notices) that are ready
inside the window wait and send, in their usual order, when it ends. Tasks still
run at their scheduled time. Replies to your messages, approval prompts, and tasks
without a messaging destination are never held. `tasks show` reports a held post
with `heldUntil`; the worker log notes each held window once.

On a daylight-saving change, a `start` or `end` that does not exist that day
takes effect when the clocks jump past it, and one that occurs twice takes effect
at its first occurrence. A window ending at 01:30 on the night the clocks go back
therefore ends at the first 01:30 and does not resume for the repeated hour.

The worker reads the setting when it starts and checks it before each post, so
after `poppet worker restart` a changed or removed window also applies to posts
already waiting.

## Discord

The existing `poppet gateway discord setup` command saves the token separately
and merges the ordinary settings into `config.json` without replacing other fields:

```json
{
  "discord": {
    "ownerId": "200",
    "guildId": "300",
    "homeChannelId": "400"
  }
}
```

Use your own IDs. Only the configured owner can invoke the agent, in any accessible text channel or thread in the configured server. The home
channel is the default destination for proactive messages, including scheduled results. Removing the `discord` section disables Discord while retaining
its saved token. The bot identity comes from Discord after token authentication. See
[Discord setup](gateways/discord.md) for permissions and secure token input.

Setup serializes writes. A malformed configuration prevents connection instead
of broadening access. Credentials contain only the bot token; loading settings
does not rewrite either file.

## Slack

`poppet setup` or `poppet gateway slack setup` saves both tokens in
`channels/slack.json` and merges ordinary settings into `config.json`:

```json
{
  "slack": {
    "ownerId": "U123",
    "teamId": "T123",
    "homeChannelId": "C123"
  }
}
```

Use your own IDs. Only the configured owner can invoke Poppet in accessible,
unshared channels in that workspace. Removing `slack` disables the adapter and
retains the saved tokens. See [Slack setup](gateways/slack.md) for app scopes,
Socket Mode, and masked token entry. Restart the worker after changing settings.

## Environment

Only `POPPET_DATA_DIR` and credential overrides configure Poppet through the
environment. Keep ordinary settings in `config.json` so terminal and
background-worker behavior agree.

Bash / Zsh / POSIX sh:

```sh
export POPPET_DATA_DIR="$HOME/.local/share/poppet"
poppet config
```

fish:

```fish
set -lx POPPET_DATA_DIR "$HOME/.local/share/poppet"
poppet config
```

An empty data-directory value fails. Missing config files use defaults and do not
create files. Secret overrides remain supported; empty or invalid secrets fail
instead of falling back to saved credentials. MCP child processes can still use
the environment and credential references explicitly listed in their server entries.

## Reasoning logs

Poppet always requests readable reasoning when the provider supports it and saves
it with each assistant message's provider continuation in the session database,
whatever this setting says.

Set `chat.logReasoning` to `true` to also show readable reasoning in CLI diagnostics
and `<data directory>/logs/worker.log`. It covers chat, messaging, and scheduled
runs. Answer output and gateway replies contain only the answer. The provider
must return readable reasoning; encrypted continuation metadata is never logged.
Logged reasoning is limited to 128 KiB per run (`limits.replyTextBytes`) and buffered diagnostic entries are
flushed on failure or interruption. Logs can contain private prompt or tool content and
use the existing protected files and rotation. This setting does not select
reasoning effort or a reasoning-token budget.

## Timing logs

Set `chat.logTimings` to `true` to log stage durations in milliseconds. Entries
include session/run IDs and stage outcomes for model resolution, inference,
tools, naming, and the overall run. Worker-backed CLI clients also receive these
diagnostics. Nested durations overlap and must not be added together. Prompts,
answers, tool arguments, and credentials are excluded.

## API keys

API-key login saves credentials under `<POPPET_DATA_DIR>/auth/openrouter.json`,
`opencode.json`, or `opencode-go.json`, with `0600` file permissions inside a `0700` directory.
Writes replace files atomically and use a separate lock for each provider.
Login always masks typed or pasted characters with `*` and requires an interactive terminal. It does not
read keys from environment variables, command-line arguments, or piped input.

`POPPET_OPENROUTER_API_KEY`, `POPPET_OPENCODE_API_KEY`, and
`POPPET_OPENCODE_GO_API_KEY` override stored keys
for inference and status. Empty or invalid overrides fail instead of falling
back to a stored key. Status reports the credential source without secrets;
remote access is checked when making model requests. `provider logout openrouter`
removes that provider's saved key. It leaves other providers connected and does
not revoke the remote key or unset an environment override.

See [OpenCode](providers/opencode.md), [OpenCode Go](providers/opencode-go.md), and [OpenRouter](providers/openrouter.md) for login and model-selection examples.

## Skill files

Skills live in `<POPPET_DATA_DIR>/skills/<name>/SKILL.md`, with no configurable
path. Each file is limited to 8192 UTF-8 bytes and counts against the context
budget. See [skills](skills.md).

## Page reading

Page reading uses the model-turn, tool-call, context, and tool-output limits.
Each request has a 15-second deadline, at most three redirects, and a 1 MiB body
limit by default; see [timeouts and limits](#timeouts-and-limits). Only HTTP(S) standard ports are accepted. Ambient proxies and credentials
are not forwarded. See [page reading](chat.md#read-a-supplied-url).

The retired `browser` configuration key is ignored. Built-in browser automation and
built-in web search (`webSearch` and `webSearchProvider`, rejected as unknown fields)
are no longer available; static page reading, [MCP servers](mcp.md), and reviewed
Bash commands remain available.
