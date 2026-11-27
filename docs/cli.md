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
first prints the saved provider and model, each gateway's state, and the worker
state, then numbers its steps. A fresh setup runs every step. When `config.json`
already names a provider, setup asks whether to change everything, only the
provider and model, only the gateways, only the worker, or nothing. Every choice
except nothing ends with the worker step. `poppet setup provider`, `poppet setup
gateways`, and `poppet setup worker` run one step, plus the worker step, without
asking.

The provider step reuses saved choices, offers to reconnect an existing provider,
and lists that provider's models. It then offers the provider's verification
request for the chosen model. If the request fails, the owner can keep the model
or choose another. A failed sign-in or model list offers a retry, another
provider, or quitting. The gateway step lists the gateways that have a
`promptSetup` in one multi-select, with configured gateways selected, and prompts
for each selected one. Each gateway asks for its token first and checks it with a
read-only platform call. Discord then suggests the application owner as the
owner, and lists the bot's servers and their text channels. Slack takes the
workspace from the bot token, checks the app token, and lists the channels the
bot belongs to. Telegram reads the bot's queued updates without confirming them,
so the worker still answers them later, and offers the people who messaged the
bot privately as the owner and the owner's private chat or a group as the chat.
A group asks for a home conversation, defaulting to the whole chat. Every list
has an option to type an ID. When a check rejects a
token, setup offers to enter it again, continue with typed IDs, or skip that
gateway and keep its saved settings. The review marks a gateway whose check failed as
not checked. Leaving a configured gateway unselected asks whether to
remove its settings and tokens, and keeps them unless confirmed. When two or more
gateways stay configured, setup asks for the
[home gateway](configuration.md#home-gateway), and it clears a saved home
gateway that the step removes. A saved home gateway from `gatewayPackages` is
offered as an option to keep. Saved gateway settings that cannot be read show as
unreadable and do not stop the other steps; selecting that gateway replaces
them, and leaving it unselected offers to remove them. Token input
shows asterisks. If the provider's key comes from the environment, setup still
asks for one and saves it for the background worker.

Before saving, setup shows a review of the provider, model, and each gateway's
pending change, with tokens shown only as replaced or kept. The owner can save,
redo the provider or gateway step, or cancel without saving. Redoing the gateway
step starts again from the saved settings. Saves happen in order: authentication
at once, then the provider and model, then each gateway. Cancelling or a later
failure keeps completed saves and reports them. Setup preserves other `config.json` settings, never overwrites
invalid configuration, and runs inference only for the offered test request. On macOS and
Linux with systemd, it offers to install, start, or restart the worker. A restart
can interrupt active runs.

Setup ends by running the [doctor](doctor.md) checks and listing only the
findings that need attention, then prints next steps for the terminal, each
configured gateway, and doctor. A worker that has just started can show as not
responding.
