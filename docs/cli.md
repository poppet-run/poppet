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

Run `poppet doctor` for read-only setup and worker inspection, or
`poppet doctor --json` for scripts. See [doctor](doctor.md) for checks, exit codes,
and limits.

## Output

Commands print human-readable text: lists as aligned tables, single records as
labelled fields, and changes as a short confirmation. Times are shown in the
local timezone to the minute. On a terminal, the last table column is shortened
to fit the window; redirected output keeps full values. `NO_COLOR=1` disables
styling.

Commands that report data accept `--json` to print the full result as JSON
instead, with Unix-millisecond timestamps and every field. Use it in scripts:

```sh
poppet tasks list --json
poppet memory set --json project "Poppet"
```

For commands that take free text, put `--json` before the text; after it,
`--json` is part of the text. `--json` is available on `config`, `doctor`,
`provider status` and `models`, `web status`, `chat rename`, `search`,
`sessions` and `show`, `skills list` and `show`, all `memory` and `tasks`
commands, `mcp servers` and `tools`, `store status`, and `worker status`.
Commands that stream answers, prompt for input, or only confirm a setup step
print text only.

## Shell completions

`poppet --completions <shell>` prints a completion script for `bash`, `zsh`, or
`fish`. Scripts cover commands, subcommands, and flags, but not saved values such
as session IDs or skill names. Like help, generating a script needs no
configuration or credentials. Regenerate the script after updating Poppet.

Bash:

```sh
poppet --completions bash > ~/.local/share/bash-completion/completions/poppet
```

zsh, with `~/.zsh/completions` on `fpath` before `compinit` runs:

```sh
poppet --completions zsh > ~/.zsh/completions/_poppet
```

fish:

```fish
poppet --completions fish > ~/.config/fish/completions/poppet.fish
```

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

On macOS, setup offers to install and start the worker, start an installed
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

| Command                               | Action                                  |
| ------------------------------------- | --------------------------------------- |
| `provider login [provider] [options]` | Sign in or save an API key.             |
| `provider status [provider]`          | Show connection status without secrets. |
| `provider models [provider]`          | List available models.                  |
| `provider logout [provider]`          | Clear that provider's saved connection. |

`--key-stdin` applies to API-key providers. `--no-browser` and
`--callback-port <port>` apply to browser sign-in; see
[headless and remote machines](providers/openai-chatgpt.md#headless-and-remote-machines).
See [ChatGPT](providers/openai-chatgpt.md), [OpenCode Go](providers/opencode-go.md),
[OpenRouter](providers/openrouter.md), and [API-key handling](configuration.md#api-keys)
for provider-specific setup and logout behavior.

## MCP servers

| Command                                                | Purpose                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| `mcp servers`                                          | Show permissions, connection diagnostics, sign-in state, and tools. |
| `mcp tools <server>`                                   | Discover every tool with its interactive and scheduled permissions. |
| `mcp add <server> <url> --auth <none\|api-key\|oauth>` | Save a remote server without connecting or allowing tools.          |
| `mcp login <server>`                                   | Sign in to an OAuth server.                                         |
| `mcp logout <server>`                                  | Delete an OAuth server's saved tokens.                              |
| `mcp allow <server> <tools...>`                        | Allow discovered tools for interactive runs.                        |
| `mcp allow <server> --all`                             | Allow all currently discovered names for interactive runs.          |
| `mcp deny <server> <tools...>`                         | Remove interactive and scheduled permissions.                       |
| `mcp remove <server>`                                  | Remove the entry and the key or sign-in that Poppet saved for it.   |

With `--auth api-key`, `add` reads a hidden prompt or accepts `--api-key <key>`.
Custom headers and prefixes, OAuth client IDs, and scopes are configured in
`config.json`. `login` accepts `--no-browser` and `--callback-port <port>`;
the latter overrides the configured port for that sign-in only.

`allow --scheduled` grants both permissions for explicitly named, reviewed
read-only tools. `deny --scheduled` removes only scheduled access. `--all`
cannot be combined with names or `--scheduled`. Failed discovery or unknown
names leave permissions unchanged; `deny` works without connecting.

`servers` and `tools` need no model and route through the worker when running.
Configuration changes from `add`, `remove`, `allow`, and `deny` take effect in
the worker after restart. A running worker uses new sign-in tokens on its next
request. See [MCP tools](mcp.md) for configuration and permissions.

## Web search setup

| Command                       | Action                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `web login [--api-key <key>]` | Save the selected search provider's key from the flag or hidden prompt.           |
| `web status`                  | Show whether search is enabled and a key is configured, without a remote request. |
| `web logout`                  | Remove the saved search key.                                                      |

These commands use `webSearchProvider`, which defaults to `brave` and also accepts
`kagi`. They do not change inference credentials or require a selected model.
Enable `webSearch` separately and restart any running worker. See
[configuration](configuration.md#web-search) for credentials and query handling.

## Chat

| Command                                                    | Action                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------- |
| `chat interactive [session] [--skill <name>]`              | Open a terminal prompt for a new or saved session.      |
| `chat new [--skill <name>] [--attach <path>]... <message>` | Start a session with the configured provider and model. |
| `chat send <session> [--attach <path>]... <message>`       | Continue a saved session.                               |
| `chat rename <session> <title>`                            | Rename a saved session without inference.               |
| `chat search <query>`                                      | Search completed conversation text without inference.   |
| `chat sessions`                                            | List saved sessions.                                    |
| `chat show <session>`                                      | Show saved messages and run outcomes.                   |

See [chat](chat.md) for session selection, streaming, cancellation, limits,
attachments, and the tools available during a run.

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
| `memory set <key> <value>`       | Create a fact or replace its value.                 |
| `memory forget <key>`            | Delete a saved fact.                                |
| `memory history <key>`           | Show a fact's revisions with origin and source run. |
| `memory revert <key> <revision>` | Restore an earlier revision as a new revision.      |

Memory commands manage the shared facts.
See [memory](memory.md) for keys, limits, profiles, and deletion behavior.

## Scheduled tasks

| Command                                                                                                                 | Action                                                             |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `tasks add <name> (--at <timestamp> \| --in <duration>) [--skill <name>] [--to <gateway>[:<conversation-id>]] <prompt>` | Schedule a one-off request.                                        |
| `tasks add <name> --cron <expression> --tz <timezone> [--skill <name>] [--to <gateway>[:<conversation-id>]] <prompt>`   | Schedule recurring work.                                           |
| `tasks edit <task> [--name <name>] [--prompt <prompt>] [--at <timestamp> \| --cron <expression> --tz <timezone>]`       | Edit definition fields while retaining task identity and history.  |
| `tasks run <task>`                                                                                                      | Queue normal scheduled work without shifting recurring cadence.    |
| `tasks` / `tasks list`                                                                                                  | List saved tasks.                                                  |
| `tasks show <task>`                                                                                                     | Show occurrences, results, delivery states, and skipped intervals. |
| `tasks pause <task>`                                                                                                    | Pause scheduling and cancel pending work.                          |
| `tasks resume <task>`                                                                                                   | Resume future occurrences.                                         |
| `tasks cancel <task> [--occurrence <id>]`                                                                               | Cancel pending or active work.                                     |
| `tasks retry <task> [--occurrence <id>]`                                                                                | Explicitly retry an unsuccessful occurrence.                       |
| `tasks remove <task>`                                                                                                   | Remove one task and its history; rejects running tasks.            |
| `tasks clear`                                                                                                           | Interrupt active work and remove all tasks and task history.       |

See [scheduled tasks](tasks.md) for timezones, missed work, retry rules, and what
`clear` deletes or retains. Tasks execute while a worker with scheduling enabled
is running. Use `--to <gateway>` to deliver to that gateway's home channel, or
`--to <gateway>:<conversation-id>` to select another channel or thread.

## Messaging

| Command                                                                                            | Action                                   |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `gateway discord setup --owner-id <id> --guild-id <id> --home-channel-id <id> --bot-token <token>` | Save Discord settings and the bot token. |

See [Discord](gateways/discord.md) for setup, conversation behavior,
controls, and uncertain deliveries. Use `poppet setup` for masked token entry.

## Worker

| Command            | Action                                                          |
| ------------------ | --------------------------------------------------------------- |
| `worker run`       | Run scheduling and configured messaging adapters.               |
| `worker install`   | Install and start the login worker.                             |
| `worker start`     | Start an installed worker.                                      |
| `worker restart`   | Restart an installed worker, interrupting active work.          |
| `worker stop`      | Stop it until the next login or explicit start.                 |
| `worker status`    | Show login service, scheduling, provider, and messaging status. |
| `worker logs`      | Print the last 64 KiB of worker logs.                           |
| `worker uninstall` | Stop and remove login startup, retaining saved data.            |

See [worker](worker.md) for foreground modes, login lifecycle commands, logs,
interactive requests, and recovery. `worker status` includes messaging connection,
queue, and delivery status under `worker.messaging`. Only one worker can own a data directory
at a time. Commands use the worker while it is running and run locally when it
is stopped; a lost response does not cause command replay.
