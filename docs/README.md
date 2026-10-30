# Documentation

[Project README](../README.md)

Start with [getting started](getting-started.md) to install dependencies, connect a provider, and send your first message.

Shell commands work in Bash, POSIX sh, and fish unless separate examples are shown.
Replace angle-bracket placeholders such as `<task-id>` before running a command.
Environment overrides last for the current shell scope. Use [configuration](configuration.md)
for persistent settings.

## Guides

- [Configuration](configuration.md): one settings file, credentials, Discord migration, and run controls.
- [Command line](cli.md): commands, provider selection, and verification.
- [Doctor](doctor.md): read-only setup checks, worker observations, and actionable findings.
- [Chat](chat.md): saved sessions, streaming answers, context, and cancellation.
- [MCP tools](mcp.md): trusted local and HTTP servers, allowlists, inspection, and scheduled reads.
- [Skills](skills.md): explicitly selected local procedures saved with chats and tasks.
- [Memory](memory.md): an editable profile and explicitly saved facts shared across sessions.
- [Storage](storage.md): the local database, permissions, ownership, and recovery.
- [Scheduled tasks](tasks.md): one-off and recurring work, results, pauses, and retries.
- [Worker](worker.md): foreground modes, macOS and Linux login startup, lifecycle, and logs.

## Gateways

- [Host commands](commands.md): reviewed Bash execution, Discord approval, and cron behavior.
- [Discord](gateways/discord.md): bot setup, thread sessions, permissions, and delivery.

## Providers

- [ChatGPT](providers/openai-chatgpt.md): browser sign-in, subscription access, consent, and logout.
- [OpenCode Go](providers/opencode-go.md): API-key setup and supported models.
- [OpenRouter](providers/openrouter.md): API-key setup, model discovery, and routing constraints.

## Development

- [Development](development.md): workspace layout, checks, tests, and adding providers or channels.
- [Architecture](architecture.md): service boundaries, Effect conventions, storage, and execution contracts.
- [Implementation plan](implementation-plan.md): planned work.
