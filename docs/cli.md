# Command line

[Documentation index](README.md)

After [installing the command](getting-started.md#install-the-command), run `poppet` from any directory. Run
`poppet --help` for the current command syntax. Angle-bracket values below
are placeholders; replace them before running a command. Quote prompts and values
that contain spaces.

Every command has its own help, for example `poppet tasks add --help` or
`poppet provider login -h`. Help works without credentials. Gateway help reads configuration to list external
adapters; other help works without valid configuration.
Argument errors print the relevant command's help and exit unsuccessfully.
The remaining words of a message, memory value, or task prompt are joined with
spaces; flags inside that text stay literal. Use `--` before the text when it
starts with `--help` or `-h`. For task prompts, use `--` before any initial
flag-like text; unknown task options are rejected.

## Configuration and storage

| Command        | Action                                                                                  |
| -------------- | --------------------------------------------------------------------------------------- |
| `setup`        | Interactively choose a provider and model, configure Discord, and offer worker startup. |
| `config`       | Print validated configuration without opening storage or contacting a provider.         |
| `store status` | Open or migrate the local database and print its path, schema version, and counts.      |
| `--help`       | Print command help.                                                                     |

See [configuration](configuration.md) and [storage](storage.md).

`setup` requires an interactive terminal. It reuses saved choices, offers reconnect
for an existing provider, and lists models from that provider. Discord is optional;
skipping it leaves its policy and token unchanged. Discord token input displays
asterisks. Other settings in `config.json` are preserved.

If the selected provider uses an API key from the shell environment, setup saves
it through the existing login command so the background worker can use it too.

Authentication saves immediately. Provider and model choices save after the
prompts, followed by Discord if selected. Cancellation or a later failure keeps
completed saves and reports that they remain. Invalid configuration is never
overwritten. Setup does not run inference or test Discord access.

On macOS, setup offers to install and start the combined worker, start an installed
worker, or explicitly restart a loaded worker. Restarting can interrupt active runs.
Other platforms get the foreground command. Use the individual provider, gateway,
and worker commands for scripts; setup has no noninteractive mode.

## Providers and models

Select a provider and an explicit model. Provider commands default to the `provider` in `config.json`.
Pass a provider after `login`, `status`, `models`, or `logout`, or use
`--provider <id>`. This selects which provider to inspect or manage without
changing the configured inference provider. These commands need no selected model.

Save the provider and model in `config.json`:

```json
{
  "provider": "openai-chatgpt",
  "model": "replace-with-model-id"
}
```

```sh
poppet provider models openai-chatgpt
```

The runtime builds only the selected provider's dependencies and never falls
back to another model. ChatGPT's browser login handles plan-usage consent
through `provider login openai-chatgpt`.

| Command                                   | Action                                  |
| ----------------------------------------- | --------------------------------------- |
| `provider login [provider] [--key-stdin]` | Sign in or save an API key.             |
| `provider status [provider]`              | Show connection status without secrets. |
| `provider models [provider]`              | List available models.                  |
| `provider logout [provider]`              | Clear that provider's saved connection. |

`--key-stdin` applies to API-key providers.
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

| Command                   | Action                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `web login [--key-stdin]` | Save the selected search provider's key from the environment, hidden prompt, or explicit stdin. |
| `web status`              | Show whether search is enabled and a key is configured, without a remote request.               |
| `web logout`              | Remove the saved search key.                                                                    |

These commands use `webSearchProvider`, which defaults to `brave` and also accepts
`kagi`. They do not change inference credentials or require a selected model.
Enable `webSearch` separately and restart any running worker. See
[configuration](configuration.md#web-search) for credentials and query handling.

## Chat

| Command                                                  | Action                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `chat interactive [session] [--coding] [--skill <name>]` | Open a terminal prompt for a new or saved session.          |
| `chat new [--coding] [--skill <name>] <message>`         | Start a session with the configured provider and model.     |
| `chat send <session> <message>`                          | Continue a saved session.                                   |
| `chat rename <session> <title>`                          | Rename a saved session without inference.                   |
| `chat search <query>`                                    | Search completed conversation text without inference.       |
| `chat sessions`                                          | List saved sessions.                                        |
| `chat show <session>`                                    | Print saved messages, tool calls, and run outcomes as JSON. |

See [chat](chat.md) for session selection, streaming, cancellation, limits,
and the tools available during a run.

## Skills

| Command              | Action                        |
| -------------------- | ----------------------------- |
| `skills list`        | List owner skill directories. |
| `skills show <name>` | Show an owner SKILL.md file.  |

Use `--skill <name>` before a new chat message or task prompt to save the current
procedure with that session or task. See [skills](skills.md) for examples and limits.

## Memory

| Command                          | Action                                              |
| -------------------------------- | --------------------------------------------------- |
| `memory list`                    | List explicitly saved facts.                        |
| `memory remember <key> <value>`  | Create a new fact.                                  |
| `memory replace <key> <value>`   | Change an existing fact.                            |
| `memory forget <key>`            | Delete a saved fact.                                |
| `memory history <key>`           | Show a fact's revisions with origin and source run. |
| `memory revert <key> <revision>` | Restore an earlier revision as a new revision.      |

Memory commands manage the shared facts.
See [memory](memory.md) for keys, limits, profiles, and deletion behavior.

## Scheduled tasks

| Command                                                                                                                            | Action                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `tasks add <name> --at <timestamp> [--coding] [--skill <name>] [--channel <id> [--conversation <id>]] <prompt>`                    | Schedule a one-off request.                                        |
| `tasks add <name> --cron <expression> --tz <timezone> [--coding] [--skill <name>] [--channel <id> [--conversation <id>]] <prompt>` | Schedule recurring work.                                           |
| `tasks edit <task> [--name <name>] [--prompt <prompt>] [--at <timestamp> \| --cron <expression> --tz <timezone>]`                  | Edit definition fields while retaining task identity and history.  |
| `tasks skip-next <task>`                                                                                                           | Consume exactly the next execution.                                |
| `tasks snooze <task> --until <timestamp>`                                                                                          | Delay the next execution to a later offset-qualified instant.      |
| `tasks run <task>`                                                                                                                 | Queue normal scheduled work without shifting recurring cadence.    |
| `tasks list`                                                                                                                       | List saved tasks.                                                  |
| `tasks show <task>`                                                                                                                | Show occurrences, results, delivery states, and skipped intervals. |
| `tasks pause <task>`                                                                                                               | Pause scheduling and cancel pending work.                          |
| `tasks resume <task>`                                                                                                              | Resume future occurrences.                                         |
| `tasks cancel <occurrence>`                                                                                                        | Cancel pending or active work.                                     |
| `tasks retry <occurrence>`                                                                                                         | Explicitly retry an unsuccessful occurrence.                       |
| `tasks clear`                                                                                                                      | Interrupt active work and remove all tasks and task history.       |

See [scheduled tasks](tasks.md) for timezones, missed work, retry rules, and what
`clear` deletes or retains. Tasks execute while a worker with scheduling enabled
is running. Use `--channel` to deliver to that gateway's home channel. Add `--conversation` to select another channel or thread.

## Messaging

| Command                                                                     | Action                                                   |
| --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `gateway discord setup <owner-id> <guild-id> <home-channel-id> --key-stdin` | Save Discord settings and read the bot token from stdin. |
| `gateway work`                                                              | Run messaging only in the foreground.                    |
| `gateway status`                                                            | Show connection, queue, and delivery status.             |

See [Discord](gateways/discord.md) for setup, conversation behavior,
controls, and uncertain deliveries. The bot token is never accepted as a command-line argument.

## Worker

| Command                             | Action                                                 |
| ----------------------------------- | ------------------------------------------------------ |
| `worker run [--tasks-only]`         | Run scheduling and messaging, or scheduling only.      |
| `worker install`                    | Install and start the login worker.                    |
| `worker start`                      | Start an installed worker.                             |
| `worker stop`                       | Stop it until the next login or explicit start.        |
| `worker status`                     | Show login service, scheduling, and connection status. |
| `worker logs`                       | Print the last 64 KiB of worker logs.                  |
| `worker resume-provider <provider>` | Allow scheduled requests for a provider again.         |
| `worker providers`                  | Show provider quota pauses and temporary backoff.      |
| `worker uninstall`                  | Stop and remove login startup, retaining saved data.   |

See [worker](worker.md) for foreground modes, macOS lifecycle commands, logs,
interactive requests, and recovery. Only one worker mode can own a data directory
at a time. Commands use the worker while it is running and run locally when it
is stopped; a lost response does not cause command replay.
