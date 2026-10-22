# Poppet

A small personal AI agent for local use, built with TypeScript, Bun, and Effect.

Poppet streams chat through ChatGPT, OpenCode Go, or OpenRouter and saves sessions
locally. It can read, search, and save notes, use an editable profile and saved
facts, prepare notes for owner approval, keep explicitly selected project context, follow local Markdown skills, read supplied URLs, search
the web when configured, use explicitly allowed local MCP tools, recall saved discussions, manage scheduled tasks through chat, and reply in Discord threads or
private Telegram and WhatsApp chats. Telegram also accepts bounded text/PDF documents
and optional local voice transcription. A shared worker runs scheduling and messaging;
on macOS it can start at login.

## Quick start

Requires Bun 1.4.3, pinned in `mise.toml` and `package.json`, and access to a
supported provider. Run these commands from the repository root:

```fish
bun install --frozen-lockfile
bun run start auth login openai-chatgpt
bun run start auth models openai-chatgpt
```

Choose a model ID from the returned catalog, then start a chat:

```fish
set -lx POPPET_PROVIDER openai-chatgpt
set -lx POPPET_MODEL 'replace-with-model-id'
bun run start chat new "Help me plan a small TypeScript project"
```

Use `bun run start chat interactive` for a terminal prompt, or append a saved
session ID to resume it. Chat consumes provider usage. OpenCode Go supports coding
workloads only.
Save persistent settings in `~/.config/poppet/config.json`; environment variables
override file values. See [configuration](docs/configuration.md) for supported fields.
See [getting started](docs/getting-started.md) for setup and session continuation,
or choose another [provider](docs/index.md#providers).

## Documentation

The [documentation index](docs/index.md) links to all guides and references.

- [Configuration](docs/configuration.md)
- [Command line](docs/cli.md)
- [Notes](docs/notes.md), [memory](docs/memory.md), [projects](docs/projects.md), and [MCP tools](docs/mcp.md)
- [Scheduled tasks](docs/tasks.md), [owner approvals](docs/approvals.md), and [worker](docs/worker.md)
- [Discord](docs/gateways/discord.md), [Telegram](docs/gateways/telegram.md), and [WhatsApp](docs/gateways/whatsapp.md)
- [Development](docs/development.md)

## Licence

BSD 3-Clause. See [LICENSE](LICENSE).
