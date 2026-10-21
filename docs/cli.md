# Command line

[Documentation index](index.md)

Run commands from the repository root with `bun run start`. Run
`bun run start --help` for the current command syntax. Angle-bracket values below
are placeholders; replace them before running a command. Quote prompts and values
that contain spaces.

Every command has its own help, for example `bun run start tasks add --help` or
`bun run start auth login -h`. Help works without valid configuration or credentials.
Argument errors print the relevant command's help and exit unsuccessfully.
The remaining words of a message, memory value, or task prompt are joined with
spaces; flags inside that text stay literal. Use `--` before the text when it
starts with `--help` or `-h`.

## Configuration and storage

| Command        | Action                                                                             |
| -------------- | ---------------------------------------------------------------------------------- |
| `config`       | Print validated configuration without opening storage or contacting a provider.    |
| `store status` | Open or migrate the local database and print its path, schema version, and counts. |
| `--help`       | Print command help.                                                                |

See [configuration](configuration.md) and [storage](storage.md).

## Providers and models

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

To verify a provider without changing `POPPET_PROVIDER`, use
`bun run start auth verify <model-id> --provider openrouter`. ChatGPT's browser
login and `--consent` remain available through `auth login openai-chatgpt`.

| Command                                            | Action                                             |
| -------------------------------------------------- | -------------------------------------------------- |
| `auth login [provider] [--consent \| --key-stdin]` | Sign in or save an API key.                        |
| `auth status [provider]`                           | Show connection status without secrets.            |
| `auth models [provider]`                           | List available models.                             |
| `auth verify [model]`                              | Verify inference and a local tool round trip.      |
| `auth logout [provider]`                           | Clear that provider's saved connection.            |
| `provider models`                                  | List supported models for the configured provider. |
| `provider verify`                                  | Verify the configured provider and model.          |

`--consent` applies to ChatGPT; `--key-stdin` applies to API-key providers.
See [ChatGPT](providers/openai-chatgpt.md), [OpenCode Go](providers/opencode-go.md),
[OpenRouter](providers/openrouter.md), and [API-key handling](configuration.md#api-keys)
for provider-specific setup and logout behavior.

## MCP inspection

| Command              | Action                                                                           |
| -------------------- | -------------------------------------------------------------------------------- |
| `mcp servers`        | Show configured permissions and connection state without launching servers.      |
| `mcp status`         | Show connection diagnostics and available tools without launching servers.       |
| `mcp tools <server>` | Explicitly discover the server's allowed tools using the owner or a local scope. |

These commands need no model. They route through the worker when it is running.
See [MCP tools](mcp.md) for configuration, permissions, and process ownership.

## Web search setup

| Command                   | Action                                                                            |
| ------------------------- | --------------------------------------------------------------------------------- |
| `web login [--key-stdin]` | Save a Brave Search key from the environment, hidden prompt, or explicit stdin.   |
| `web status`              | Show whether search is enabled and a key is configured, without a remote request. |
| `web logout`              | Remove the saved search key.                                                      |

These commands do not change inference credentials or require a selected model.
Enable `webSearch` separately and restart any running worker. See
[configuration](configuration.md#web-search) for credentials and query handling.

## Chat

| Command                                                  | Action                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `chat interactive [session] [--coding] [--skill <name>]` | Open a terminal prompt for a new or saved session.          |
| `chat new [--coding] [--skill <name>] <message>`         | Start a session with the configured provider and model.     |
| `chat send <session> <message>`                          | Continue a saved session.                                   |
| `chat search <query>`                                    | Search completed conversation text without inference.       |
| `chat sessions`                                          | List saved sessions.                                        |
| `chat show <session>`                                    | Print saved messages, tool calls, and run outcomes as JSON. |

See [chat](chat.md) for session selection, streaming, cancellation, and limits,
and [notes](notes.md) for the tools available during a run.

## Skills

| Command              | Action                                                     |
| -------------------- | ---------------------------------------------------------- |
| `skills list`        | List local skill directories without opening the database. |
| `skills show <name>` | Read and validate a local SKILL.md file.                   |

Use `--skill <name>` before a new chat message or task prompt to save the current
procedure with that session or task. See [skills](skills.md) for examples and limits.

## Memory

| Command                         | Action                       |
| ------------------------------- | ---------------------------- |
| `memory list`                   | List explicitly saved facts. |
| `memory remember <key> <value>` | Create a new fact.           |
| `memory replace <key> <value>`  | Change an existing fact.     |
| `memory forget <key>`           | Delete a saved fact.         |

See [memory](memory.md) for keys, limits, profiles, and deletion behavior.

## Scheduled tasks

| Command                                                                                                                                                              | Action                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `tasks add <name> --at <timestamp> [--coding] [--skill <name>] [--discord-thread <id>] [--telegram-chat <id>] [--whatsapp-chat <phone>] <prompt>`                    | Schedule a one-off request.                                        |
| `tasks add <name> --cron <expression> --tz <timezone> [--coding] [--skill <name>] [--discord-thread <id>] [--telegram-chat <id>] [--whatsapp-chat <phone>] <prompt>` | Schedule recurring work.                                           |
| `tasks edit <task> [--name <name>] [--prompt <prompt>] [--at <timestamp>                                                                                             | --cron <expression> --tz <timezone>]`                              | Edit definition fields while retaining task identity and history. |
| `tasks skip-next <task>`                                                                                                                                             | Consume exactly the inspected next execution.                      |
| `tasks snooze <task> --until <timestamp>`                                                                                                                            | Delay the next execution to a later offset-qualified instant.      |
| `tasks run-now <task>`                                                                                                                                               | Queue normal read-only work without shifting recurring cadence.    |
| `tasks list`                                                                                                                                                         | List saved tasks.                                                  |
| `tasks show <task>`                                                                                                                                                  | Show occurrences, results, delivery states, and skipped intervals. |
| `tasks pause <task>`                                                                                                                                                 | Pause scheduling and cancel pending work.                          |
| `tasks resume <task>`                                                                                                                                                | Resume future occurrences.                                         |
| `tasks cancel <occurrence>`                                                                                                                                          | Cancel pending or active work.                                     |
| `tasks retry <occurrence>`                                                                                                                                           | Explicitly retry an unsuccessful occurrence.                       |
| `tasks clear`                                                                                                                                                        | Interrupt active work and remove all tasks and task history.       |
| `tasks providers`                                                                                                                                                    | Show provider quota pauses and temporary backoff.                  |
| `tasks resume-provider <provider>`                                                                                                                                   | Allow scheduled requests for a provider again.                     |
| `tasks status`                                                                                                                                                       | Show task counts, recent outcomes, and worker status.              |
| `tasks work`                                                                                                                                                         | Run scheduling only in the foreground.                             |

See [scheduled tasks](tasks.md) for timezones, missed work, retry rules, and what
`clear` deletes or retains. Tasks execute while a worker with scheduling enabled
is running. Choose at most one messaging destination flag.

`tasks add --monitor` selects [change-aware monitoring](tasks.md#change-aware-monitoring).
It requires `--cron` and `--tz`, saves a quiet first baseline, and delivers only
later value changes. It reuses the existing destination flags and task controls.
`tasks show` includes the last successful observation and per-check decisions.

## Messaging

| Command                                                                                   | Action                                                                  |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `gateway discord setup <bot-id> <owner-id> <guild-id> <parent-channel-id>... --key-stdin` | Save Discord settings and read the bot token from stdin.                |
| `gateway telegram setup <bot-id> <owner-id> --key-stdin`                                  | Save Telegram settings and read the bot token from stdin.               |
| `gateway whatsapp setup <account-phone> <owner-phone>`                                    | Save WhatsApp personal-account and owner phone digits.                  |
| `gateway whatsapp pair`                                                                   | Pair WhatsApp by QR in an interactive terminal with the worker stopped. |
| `gateway work`                                                                            | Run messaging only in the foreground.                                   |
| `gateway status`                                                                          | Show connection, queue, and delivery status.                            |

See [Discord](gateways/discord.md), [Telegram](gateways/telegram.md), and [WhatsApp](gateways/whatsapp.md) for setup, conversation behavior,
controls, and uncertain deliveries. The bot token is never accepted as a command-line argument.

## Worker

| Command            | Action                                                 |
| ------------------ | ------------------------------------------------------ |
| `worker run`       | Run scheduling and messaging in one foreground worker. |
| `worker install`   | Install and start the macOS login worker.              |
| `worker start`     | Start an installed worker.                             |
| `worker stop`      | Stop it until the next login or explicit start.        |
| `worker status`    | Show launch agent, scheduling, and connection status.  |
| `worker logs`      | Print the last 64 KiB of worker logs.                  |
| `worker uninstall` | Stop and remove login startup, retaining saved data.   |

See [worker](worker.md) for foreground modes, macOS lifecycle commands, logs,
interactive requests, and recovery. Only one worker mode can own a data directory
at a time. Commands use the worker while it is running and run locally when it
is stopped; a lost response does not cause command replay.
