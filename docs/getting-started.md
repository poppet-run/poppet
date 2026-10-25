# Getting started

[Documentation index](README.md)

Shell commands work in Bash, POSIX sh, and fish unless separate examples are shown.
Replace angle-bracket placeholders such as `<task-id>` before running a command.

## Requirements

- Bun 1.4.4, pinned in `mise.toml` and `package.json`.
- Access to ChatGPT subscription inference, OpenCode Go, or OpenRouter.
- A system browser for ChatGPT sign-in, or an API key for the other providers.
- macOS, or Linux with systemd, for background worker installation. Other platforms can run the worker in the foreground.

## Install the command

From the repository root:

```sh
bun install --frozen-lockfile
bun link
poppet --help
poppet config
```

`bun link` adds `poppet` to Bun's global bin directory. Make sure that directory
is on `PATH`. If needed, add it for your shell:

Bash / POSIX sh:

```sh
export PATH="$(bun pm bin -g):$PATH"
```

fish:

```fish
fish_add_path (bun pm bin -g)
```

Add the `export` line to your shell's startup file to keep it across sessions.
`fish_add_path` persists the path for future fish sessions.

The command points at this checkout and uses its installed dependencies, so keep both available.
Source changes take effect without rebuilding or linking again. Run `bun unlink`
from the repository root to remove the command.

Bun must also be available outside the checkout. If you use mise without a global
Bun version, run `mise use -g bun@1.4.4` once. Check the installation by running
`poppet --help` from another directory.

All examples use `poppet`, which can run from any directory. Relative
configuration paths resolve from the current working directory. The default data
directory is `~/.config/poppet`; see [configuration](configuration.md) to change it.

## Run setup

```sh
poppet setup
```

Choose a provider, sign in if needed, and search its model list by typing. You can
also configure Discord and, on macOS or Linux with systemd, install and start the combined scheduling
and messaging worker. Have your Discord bot token, user ID, server ID, and
home channel ID ready if you want messaging. See the [Discord guide](gateways/discord.md)
for bot permissions and intents.

Setup saves ordinary settings in `config.json` and credentials in protected files.
Rerunning it uses saved choices as defaults. Skipping Discord preserves its settings.
It asks before starting or restarting the worker. Other platforms use `poppet worker run`.

Authentication is saved immediately. Cancelling later keeps completed steps;
setup reports each save. Finishing setup does not verify live inference or a Discord
connection. Check `poppet worker status`, then send a chat message to try it.

OpenCode Go supports coding workloads only. Choose ChatGPT or OpenRouter for a
general personal agent. Browser access, web search, and MCP remain separate settings.

After setup, continue with [chat](#choose-a-model-and-chat). The manual commands
below are also available for scripts and individual changes.

## Connect a provider

For ChatGPT, sign in through the system browser and list the models available to
your account:

```sh
poppet provider login openai-chatgpt
poppet provider models openai-chatgpt
poppet provider status openai-chatgpt
```

Complete account selection and plan-usage consent in the browser, then return to
the terminal for the final checks. See [ChatGPT](providers/openai-chatgpt.md) for
consent, credential storage, and logout.

Alternatively, follow the [OpenCode Go](providers/opencode-go.md) or
[OpenRouter](providers/openrouter.md) guide. OpenCode Go requires coding workloads;
use ChatGPT or OpenRouter for general assistant chat and summaries.

## Choose a model and chat

If you did not use `poppet setup`, save the provider and model in
`~/.config/poppet/config.json`, using a model ID returned by `provider models`:

```json
{
  "provider": "openai-chatgpt",
  "model": "replace-with-model-id"
}
```

```sh
poppet chat new "Help me plan a small TypeScript project"
poppet chat sessions
```

The answer streams to stdout; session and run IDs print to stderr. These one-shot
commands send one message at a time. Copy the session ID to continue or inspect it:

Bash / POSIX sh:

```sh
session_id='paste-session-id-here'
poppet chat send "$session_id" "What should I build first?"
poppet chat show "$session_id"
```

fish:

```fish
set session_id 'paste-session-id-here'
poppet chat send $session_id "What should I build first?"
poppet chat show $session_id
```

For a terminal prompt, run `poppet chat interactive`, or append a saved
session ID to resume it. Enter one message per line and use `/exit` to leave.
See the [interactive prompt guide](chat.md#interactive-prompt) for cancellation.

New sessions use the
configured provider and model; saved sessions retain their original selection.
Chat consumes provider usage.
See [command line](cli.md#providers-and-models) for provider commands and
[chat](chat.md) for session behavior and limits.

## Use memory and scheduled work

[Memory](memory.md) adds your editable profile and explicitly saved facts to each
run. [Scheduled tasks](tasks.md) execute one-off or recurring prompts while a
[worker](worker.md) is running. The same worker can connect
[Discord](gateways/discord.md).

Start the combined foreground worker after configuring the services you need:

```sh
poppet worker run
```

Keep that terminal open and use a second terminal for chat and task commands.
On macOS and Linux with systemd, the [worker guide](worker.md#login-startup) explains how to install
login startup instead.
