# Refactoring plans

[Documentation index](../index.md)

Plans for removing duplicated code and reducing complexity. Each plan is
independent unless noted, keeps behaviour unchanged, and should land as its own
change with `bun run check` passing.

| Order | Plan                                                          | Scope                                                      | Depends on                 |
| ----- | ------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------- |
| 1     | [Bounded I/O package](bounded-io.md)                          | New `@poppet/io`; bounded stream reads and subprocess runs | —                          |
| 2     | [Tool definitions](tool-definitions.md)                       | Tool parameter schemas, argument decoding, bounded text    | —                          |
| 3     | [OpenAI-compatible providers](openai-compatible-providers.md) | OpenCode Go, OpenRouter, ChatGPT client setup              | —                          |
| 4     | [Channel registration](channel-registration.md)               | Discord, Telegram, WhatsApp `load` and setup               | —                          |
| 5     | [Web search client](web-search-client.md)                     | Move the Brave client out of the CLI                       | 1                          |
| 6     | [CLI command modules](cli-commands.md)                        | Split `makeCLI` into per-area modules                      | 5 (touches `web` commands) |

## Not yet planned

`packages/tasks/src/task-store.ts` (about 1,000 lines) and
`packages/gateway/src/service.ts` (about 830 lines) are the next largest source
files. They were only skimmed; review them for a natural split before writing a
plan.
