# Command line

[Engineering notes](README.md)

`apps/cli` is the `poppet` command. `cli.ts` assembles the command tree with
`effect/cli`, and each command with supporting modules lives in
`src/commands/<command>/`, with `command.ts` defining its subcommands. `main.ts`
runs the Effect runtime. The [command reference](https://poppet.run/docs/cli/)
lists every command for users.

## Arguments

- Every command has `--help` and `-h`. Help needs no credentials. Gateway help
  reads configuration to list external adapters. All other help works without
  valid configuration.
- An argument error prints that command's help and exits with a failure.
- The remaining words of a message, memory value, or task prompt are joined with
  spaces, and flags inside that text stay literal. `--` before the text allows a
  leading `--help` or `-h`. Task prompts need `--` before any leading flag-like
  text, and unknown task options are rejected.
- Options such as `--skill`, `--attach`, and `--json` go before free text. After
  it, they are part of the text.
- `poppet --completions <bash|zsh|fish>` prints a completion script for
  commands, subcommands, and flags. It covers no saved values and needs no
  configuration.

## Output

`output.ts` prints lists as aligned tables, single records as labelled fields,
and changes as a short confirmation. Times show in the local zone to the minute.
On a terminal, the last table column is cut to the window width. Redirected
output keeps full values. `NO_COLOR` turns off styling.

Commands that report data take `--json` and print the full result with
Unix-millisecond timestamps: `approvals` (`list`, `approve`, and `deny`),
`config`, `doctor`, `provider status` and
`models`, `chat rename`, `delete`, `prune`, `search`, `sessions`, and `show`,
`skills list` and `show`, every `memory` and `tasks` command, `mcp servers` and
`tools`, `store status`, and `worker status`. Commands that stream answers,
prompt for input, or confirm a setup step print text only. Chat streams the
answer to stdout and IDs to stderr. See [chat](chat.md#command-output).

## Routing

`runtime.ts` builds only the layers a command needs. Commands that use stored
data go to the worker when it owns the data directory, and run locally
otherwise. They fall back to local only when the socket is absent or refuses the
connection. See [socket transport](worker.md#socket-transport).

| Command group                                                  | Needs a model | Opens the store | Uses the worker |
| -------------------------------------------------------------- | ------------- | --------------- | --------------- |
| `--help`, `config`, `skills`, `provider`, `gateway <id> setup` | No            | No              | No              |
| `chat new`, `chat send`, `chat`                                | Yes           | Yes             | Yes             |
| `chat sessions`, `show`, `search`, `rename`, `delete`, `prune` | No            | Yes             | Yes             |
| `memory`, `store status`, `approvals`                          | No            | Yes             | Yes             |
| `tasks`                                                        | No            | Yes             | Yes             |
| `mcp servers`, `mcp tools`                                     | No            | No              | Yes             |
| `mcp add`, `allow`, `deny`, `remove`, `login`, `logout`        | No            | No              | No              |
| `doctor`                                                       | No            | Never           | For saved work  |
| `worker run`                                                   | Per run       | Owns it         | Is the worker   |

`memory history` and `memory revert` need a running worker. Provider commands
take a provider name or `--provider <id>` and default to `provider` in
`config.json`, without changing the configured inference provider. API-key login
always prompts with hidden input, even when the environment holds a key.

## Setup

`poppet setup` needs an interactive terminal and has no noninteractive mode. It
reuses saved choices, offers to reconnect an existing provider, and lists that
provider's models. It then lists the gateways that have a `promptSetup` in one
multi-select, with configured gateways selected, and prompts for each selected
one. Leaving a configured gateway unselected asks whether to remove its
settings and tokens, and keeps them unless confirmed. Token input shows asterisks. If the provider's key comes from the
environment, setup still asks for one and saves it for the background worker.

Saves happen in order: authentication at once, the provider and model after the
prompts, then each gateway. Cancelling or a later failure keeps completed saves
and reports them. Setup preserves other `config.json` settings, never overwrites
invalid configuration, and runs no inference or messaging check. On macOS and
Linux with systemd, it offers to install, start, or restart the worker. A restart
can interrupt active runs.
