# Configuration

[Engineering notes](README.md)

Ordinary settings live in `<POPPET_DATA_DIR>/config.json`. Credentials live in
separate protected files. The environment sets only the data directory and
credential overrides, so terminal commands and the background worker see the same
settings. The [user guide](https://poppet.run/docs/configuration/) covers editing
the file.

`packages/config/src/source.ts` reads and decodes the file, including the
`timeouts` and `limits` sections.
`packages/config/src/config.ts` validates it into `Settings` and provides the
`AppConfig` service. `quiet-hours.ts` owns time zones and quiet hours. The MCP
section is validated by `@poppet/mcp/config`.

## Data directory

`POPPET_DATA_DIR` selects the directory, and `~/.config/poppet` is the default. An
empty value fails. Nothing creates the directory or a missing `config.json`.

```text
config.json   settings
web.json      web chat settings
profile.md    owner profile
soul.md       personality
skills/       skill files
auth/         provider keys, ChatGPT and MCP sign-ins, MCP credential references
channels/     gateway tokens, and Telegram's settings
gateways/     installed external gateway packages
store/        poppet.sqlite, the owner lock, and the worker socket
logs/         worker.log and its archives
```

## File rules

- The file is valid JSON of at most 64 KiB, owned by the current user, and not
  writable by group or others. Symlinks and hard links are rejected.
- Every field is optional. Unknown keys, wrong types, and invalid values fail.
  Text values must be nonempty and trimmed. `~` is not expanded.
- Writers merge into the existing file atomically and never overwrite invalid
  configuration. Loading never rewrites it.
- The worker reads the file at start. Changes need `worker restart`.
- `poppet config` validates and prints the invoking process's settings, the file
  location, and whether `POPPET_DATA_DIR` is set. It opens no storage or
  credentials and never asks the worker.

## Settings

| Field                        | Default          | Rule                                                                  |
| ---------------------------- | ---------------- | --------------------------------------------------------------------- |
| `provider`                   | `openai-chatgpt` | A registered provider ID. The first registration is the default.      |
| `model`                      | Unset            | Required for new chats, tasks, and verification.                      |
| `applicationName`            | `Poppet`         | Name sent at first ChatGPT registration.                              |
| `timeZone`                   | Unset            | An IANA zone. UTC offsets are rejected.                               |
| `discord`                    | Unset            | `ownerId`, `guildId`, `homeChannelId`. Removing it turns Discord off. |
| `slack`                      | Unset            | `ownerId`, `teamId`, `homeChannelId`. Removing it turns Slack off.    |
| `mcpServers`                 | `[]`             | See [MCP](mcp.md#configuration).                                      |
| `gatewayPackages`            | `[]`             | See [external adapters](gateways.md#external-adapters).               |
| `tasks.catchUpMinutes`       | `60`             | 0 to 1440. See [the scheduler](tasks.md#scheduler).                   |
| `tasks.approvals`            | `fail`           | `fail` or `wait`. Default approval policy for scheduled tasks.        |
| `tasks.quietHours`           | Unset            | See [quiet hours](#quiet-hours).                                      |
| `chat.outputTokens`          | `2048`           | 1 to 32768, capped by model metadata.                                 |
| `chat.runDeadlineSeconds`    | `300`            | 30 to 3600.                                                           |
| `chat.maxConcurrentRequests` | `3`              | 1 to 8. See [request slots](chat.md#request-slots).                   |
| `chat.logReasoning`          | `false`          | Log readable reasoning.                                               |
| `chat.logTimings`            | `false`          | Log stage durations.                                                  |

Timeouts and size limits are in their own sections. See
[timeouts and limits](#timeouts-and-limits). Existing sessions and tasks keep their saved
provider and model when these defaults change. The retired `browser` key is
ignored. `webSearch` and `webSearchProvider` are unknown fields and fail.

A request waiting for owner approval parks and releases its slot until the owner
answers. Concurrent ChatGPT requests share one credential lock, so
`provider login` and `logout` in another terminal report the store as busy until
no request runs.

## Time zone

`timeZone` gives scheduling chats the local date and time, and the agent uses it
for task times given without an offset or zone. `tasks add` and `tasks edit` use
it for `--cron` without `--tz`, and quiet hours use it when they have no zone of
their own. One-off `--at` times still need an offset.

## Timeouts and limits

`packages/io/src/settings.ts` defines every timeout and size limit once, with its
default and range, in `timeoutSettings` and `limitSettings`. Each package reads a
value where it uses it, through `timeout(name)`, `timeoutAfter(name)`, or
`limit(name)`, and a missing field keeps the default. The file schema rejects a
value outside its range, like any other invalid setting. `poppet config` prints
every resolved value. Every field is optional and takes a whole number. Timeouts
are in seconds, and `Bytes` fields count bytes.

```json
{
  "timeouts": { "inferenceSeconds": 180, "pageFetchSeconds": 30 },
  "limits": { "toolBytes": 32768, "historyTurns": 40 }
}
```

| Field                                | Default | Range       | Purpose                                                                                |
| ------------------------------------ | ------- | ----------- | -------------------------------------------------------------------------------------- |
| `timeouts.inferenceSeconds`          | 60      | 5 to 3600   | Absolute deadline for one model inference request                                      |
| `timeouts.providerRequestSeconds`    | 45      | 5 to 3600   | HTTP timeout for OpenAI-compatible provider requests                                   |
| `timeouts.modelCatalogSeconds`       | 30      | 1 to 300    | Provider model-list request                                                            |
| `timeouts.modelCatalogCacheSeconds`  | 60      | 0 to 86400  | How long a fetched model list is reused. 0 refetches every time                        |
| `timeouts.actionReviewSeconds`       | 30      | 1 to 600    | Automatic review of a Bash command or MCP action                                       |
| `timeouts.sessionTitleSeconds`       | 10      | 1 to 300    | Generating a chat session title                                                        |
| `timeouts.conversationNamingSeconds` | 10      | 1 to 300    | Renaming a Discord or Slack conversation                                               |
| `timeouts.pageFetchSeconds`          | 15      | 1 to 300    | Reading a public page, including redirects                                             |
| `timeouts.mcpConnectSeconds`         | 5       | 1 to 300    | Connecting to an MCP server and each tool-list request                                 |
| `timeouts.mcpStartupSeconds`         | 8       | 1 to 600    | Starting an MCP server, including discovery                                            |
| `timeouts.mcpToolCallSeconds`        | 10      | 1 to 3600   | One MCP tool call                                                                      |
| `timeouts.taskOperationSeconds`      | 8       | 1 to 300    | Creating or changing a task through the worker, and checking its messaging destination |
| `timeouts.approvalSeconds`           | 3600    | 10 to 86400 | How long an approval request stays open                                                |
| `timeouts.attachmentDownloadSeconds` | 30      | 1 to 600    | Downloading one messaging attachment                                                   |
| `timeouts.gatewayRequestSeconds`     | 10      | 1 to 300    | Discord, Slack, and Telegram API requests                                              |
| `timeouts.gatewayRetrySeconds`       | 30      | 1 to 3600   | Wait before a messaging adapter reconnects after a failure                             |
| `timeouts.gatewayRestartMaxSeconds`  | 300     | 1 to 3600   | Longest wait between messaging adapter restarts                                        |
| `timeouts.telegramPollSeconds`       | 30      | 1 to 50     | Telegram long-poll duration                                                            |

| Field                            | Default | Range             | Purpose                                                          |
| -------------------------------- | ------- | ----------------- | ---------------------------------------------------------------- |
| `limits.contextBytes`            | 256 KiB | 16 KiB to 16 MiB  | Context budget per model request                                 |
| `limits.historyTurns`            | 20      | 1 to 200          | Recent exchanges kept in context                                 |
| `limits.modelTurns`              | 16      | 1 to 128          | Model turns per run                                              |
| `limits.toolCalls`               | 16      | 1 to 256          | Tool calls per run                                               |
| `limits.toolBytes`               | 16 KiB  | 1 KiB to 64 KiB   | Size of one tool result                                          |
| `limits.soulBytes`               | 8 KiB   | 1 to 64 KiB       | `soul.md` size                                                   |
| `limits.profileBytes`            | 8 KiB   | 1 to 64 KiB       | `profile.md` size                                                |
| `limits.skillIndexBytes`         | 8 KiB   | 0 to 64 KiB       | Skill index size. 0 turns the index and skill tools off          |
| `limits.skillIndexEntries`       | 64      | 1 to 512          | Skills considered for the index                                  |
| `limits.skillDescriptionBytes`   | 240     | 16 to 4 KiB       | Size of one skill description in the index                       |
| `limits.skillMentions`           | 4       | 0 to 32           | `$skill` mentions in one message                                 |
| `limits.attachmentsPerMessage`   | 4       | 0 to 10           | Files attached to one message                                    |
| `limits.imageBytes`              | 5 MiB   | 1 KiB to 20 MiB   | Size of one image attachment                                     |
| `limits.textFileBytes`           | 64 KiB  | 1 KiB to 1 MiB    | Size of one text attachment                                      |
| `limits.imagesPerRequest`        | 8       | 0 to 64           | Images sent in one model request                                 |
| `limits.imageContextBytes`       | 6 KiB   | 1 KiB to 64 KiB   | Context budget counted for each image                            |
| `limits.replyTextBytes`          | 128 KiB | 4 KiB to 4 MiB    | Answer text, and logged reasoning, per run                       |
| `limits.completionBytes`         | 1 MiB   | 16 KiB to 16 MiB  | Serialized completion, including continuation                    |
| `limits.pageBytes`               | 1 MiB   | 64 KiB to 16 MiB  | Transferred and decoded page body                                |
| `limits.mcpTools`                | 128     | 1 to 1024         | Tools discovered from one MCP server                             |
| `limits.mcpDiscoveryBytes`       | 256 KiB | 16 KiB to 4 MiB   | Tool-list JSON from one MCP server                               |
| `limits.tasks`                   | 64      | 1 to 1024         | Saved tasks                                                      |
| `limits.chatTaskCreatesPerRun`   | 5       | 0 to 64           | Tasks one chat run can create                                    |
| `limits.chatTaskIntervalMinutes` | 5       | 1 to 1440         | Shortest interval for a recurring task created or edited in chat |
| `limits.workerLogBytes`          | 5 MiB   | 64 KiB to 256 MiB | Size of each background worker log file before rotation          |
| `limits.webChatBodyBytes`        | 256 KiB | 64 KiB to 16 MiB  | Web chat request body                                            |
| `limits.webChatStreams`          | 32      | 1 to 256          | Open web chat event streams                                      |

Larger attachment limits raise the worker request-body limit to match. Some
limits stay fixed, because stored data or a contract with the model or a platform
depends on them:

- the saved-facts budget and the fact size;
- the skill file size;
- task note and prompt sizes;
- the Bash tool's 300-second timeout ceiling;
- platform message lengths.

To add a setting, add it to `timeoutSettings` or `limitSettings`, read it with
`timeout` or `limit` where it applies, and add a row here.

## Quiet hours

`tasks.quietHours` is `{ "start": "HH:MM", "end": "HH:MM", "timeZone": "<IANA>" }`
with 24-hour wall-clock times. `timeZone` falls back to the top-level
`timeZone`, and one of them is required. A window can cross midnight. `start` and
`end` must differ.

Scheduled results and failure notices that become ready inside the window wait
until it ends, then send in their usual order. Tasks still run on time. Replies,
approval prompts, and tasks without a messaging destination are never held. See
[delivery](gateways.md#delivery) for how the loop applies the window.

On a daylight saving change, a `start` or `end` that does not exist that day
takes effect when the clocks jump past it. One that happens twice takes effect
the first time. A window ending at 01:30 on the night the clocks go back ends at
the first 01:30.

## Environment

| Variable                     | Effect                            |
| ---------------------------- | --------------------------------- |
| `POPPET_DATA_DIR`            | The data directory                |
| `POPPET_OPENROUTER_API_KEY`  | Overrides `auth/openrouter.json`  |
| `POPPET_OPENCODE_API_KEY`    | Overrides `auth/opencode.json`    |
| `POPPET_OPENCODE_GO_API_KEY` | Overrides `auth/opencode-go.json` |
| `NO_COLOR`                   | Turns off terminal styling        |

An empty or invalid override fails instead of falling back to the saved key. MCP
servers read only the variables their entries name. The installed service saves
only `POPPET_DATA_DIR`, so overrides apply to foreground processes only.

## API keys

`@poppet/credentials` saves API keys as `auth/<provider>.json`, `0600` in a
`0700` directory, by atomic replacement with a lock per provider. Login always
masks input and needs a terminal. It never reads keys from the environment,
arguments, or a pipe. Status reports the key's source without the key. Logout
removes that provider's file, leaves other providers alone, and neither revokes
the remote key nor unsets an override.

## Reasoning and timing logs

Poppet always requests readable reasoning when the provider supports it and saves
it in the continuation, whatever `chat.logReasoning` says. With the setting on,
reasoning also goes to CLI stderr and `worker.log` for chat, gateway, and
scheduled runs, up to 128 KiB per run, flushed on failure or interruption.
Answers and gateway replies never include it, and encrypted continuation is never
logged. The setting does not choose a reasoning effort.

With `chat.logTimings` on, the agent logs stage durations in milliseconds, with
session and run IDs, for model resolution, inference, tools, naming, and the
whole run. Worker-backed CLI clients get them too. Nested stages overlap, so
their durations do not add up. Prompts, answers, tool arguments, and credentials
are excluded.
