# Engineering notes

[Project README](../README.md)

These pages are for people and agents changing Poppet. They record behaviour that
must hold, where the code for it lives, and how to check a change. User guides
are at [poppet.run/docs](https://poppet.run/docs/). Update the matching page here
when behaviour changes, and the website page when users would notice.

## Start here

- [Development](development.md): setup, checks, test rules, migrations, lint, the
  source layout, and the manual live-test checklist.
- [Architecture](architecture.md): process model, Effect conventions, workspaces,
  and the rules every subsystem follows.

## Subsystems

- [Chat](chat.md): agent runs, context assembly, budgets, built-in tools, attachments,
  and failure handling.
- [Host commands](commands.md): the Bash tool, action review, and owner approval.
- [MCP](mcp.md): server configuration, allowlists, OAuth, reviewed actions, and
  result bounds.
- [Memory](memory.md): the profile, personality, saved facts, and the memory tool.
- [Skills](skills.md): skill files, the skill index, snapshots, and `$name` mentions.
- [Scheduled tasks](tasks.md): schedules, occurrences, controls, notes, delivery,
  and recovery.
- [Worker](worker.md): the worker host, socket transport, login services, and logs.
- [Web chat](web-chat.md): the HTTP listener, submission receipts, event stream, and
  frontend state.
- [Doctor](doctor.md): read-only checks, the JSON contract, and exit codes.
- [Storage](storage.md): SQLite ownership, per-package schemas, deletion, and the
  search index.
- [Configuration](configuration.md): `config.json` fields, environment variables,
  and credential files.
- [Command line](cli.md): command routing, output streams, and worker routing.

## Gateways

- [Gateways](gateways.md): registration, the adapter contract, acceptance,
  execution, delivery, and thread names.
- [Discord](gateways/discord.md): threads as sessions, attachments, approvals, and
  thread names.
- [Slack](gateways/slack.md): Socket Mode, conversation rules, and approvals.
- [Telegram](gateways/telegram.md): long polling, chats, forum topics, and limits.

## Providers

- [Providers](providers.md): the model contract, adapter rules, registration, and
  adding a provider.
- [ChatGPT](providers/openai-chatgpt.md): OAuth sign-in, registration, credential
  storage, and Responses inference.
- [OpenCode](providers/opencode.md): the `opencode` and `opencode-go` catalogs and
  protocol routing.
- [OpenRouter](providers/openrouter.md): catalog capabilities and routing rules.
- [Gemini](providers/gemini.md): catalog filtering, native streaming, and thought signatures.

Planned work is tracked in [GitHub issues](https://github.com/poppet-run/poppet/issues).
