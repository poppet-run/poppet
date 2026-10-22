# Getting started

[Documentation index](README.md)

## Requirements

- Bun 1.4.3, pinned in `mise.toml` and `package.json`.
- Access to ChatGPT subscription inference, OpenCode Go, or OpenRouter.
- A system browser for ChatGPT sign-in, or an API key for the other providers.
- macOS for background worker installation. Other platforms can run the worker in the foreground.

## Install the command

From the repository root:

```fish
bun install --frozen-lockfile
bun link
poppet --help
poppet config
```

`bun link` adds `poppet` to Bun's global bin directory. Make sure that directory
is on `PATH`, using `fish_add_path (bun pm bin -g)` if needed. The command points
at this checkout and uses its installed dependencies, so keep both available.
Source changes take effect without rebuilding or linking again. Run `bun unlink`
from the repository root to remove the command.

Bun must also be available outside the checkout. If you use mise without a global
Bun version, run `mise use -g bun@1.4.3` once. Check the installation by running
`poppet --help` from another directory.

All examples use `poppet`, which can run from any directory. Relative
configuration paths resolve from the current working directory. The default data
directory is `~/.config/poppet`; see [configuration](configuration.md) to change it.

## Connect a provider

For ChatGPT, sign in through the system browser and list the models available to
your account:

```fish
poppet auth login openai-chatgpt
poppet auth models openai-chatgpt
poppet auth status openai-chatgpt
```

Complete account selection and plan-usage consent in the browser, then return to
the terminal for the final checks. See [ChatGPT](providers/openai-chatgpt.md) for
consent, credential storage, and logout.

Alternatively, follow the [OpenCode Go](providers/opencode-go.md) or
[OpenRouter](providers/openrouter.md) guide. OpenCode Go requires coding workloads;
use ChatGPT or OpenRouter for general assistant chat, notes, and summaries.

## Choose a model and chat

Replace the example value with a model ID returned by `auth models`:

```fish
set -lx POPPET_PROVIDER openai-chatgpt
set -lx POPPET_MODEL 'replace-with-model-id'
poppet chat new "Help me plan a small TypeScript project"
poppet chat sessions
```

The answer streams to stdout; session and run IDs print to stderr. These one-shot
commands send one message at a time. Copy the session ID to continue or inspect it:

```fish
set session_id 'paste-session-id-here'
poppet chat send $session_id "What should I build first?"
poppet chat show $session_id
```

For a terminal prompt, run `poppet chat interactive`, or append a saved
session ID to resume it. Enter one message per line and use `/exit` to leave.
See the [interactive prompt guide](chat.md#interactive-prompt) for cancellation.

These `set -lx` values apply within the current shell scope. New sessions use the
configured provider and model; saved sessions retain their original selection.
Chat consumes provider usage. You can also run `poppet provider verify`
to check the selected model with two requests and a local tool round trip.
See [command line](cli.md#providers-and-models) for verification details and
[chat](chat.md) for session behavior and limits.

## Use notes, memory, and scheduled work

[Notes tools](notes.md) read, search, and save files within `POPPET_NOTES_DIR`.
[Memory](memory.md) adds your editable profile and explicitly saved facts to each
run. [Scheduled tasks](tasks.md) execute one-off or recurring prompts while a
[worker](worker.md) is running. The same worker can connect
[Discord](gateways/discord.md), [Telegram](gateways/telegram.md), and
[WhatsApp](gateways/whatsapp.md).

Start the combined foreground worker after configuring the services you need:

```fish
poppet worker run
```

Keep that terminal open and use a second terminal for chat and task commands.
On macOS, the [worker guide](worker.md#macos-login-startup) explains how to install
login startup instead.
