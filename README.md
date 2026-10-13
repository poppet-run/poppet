# Poppet

A small personal AI agent for local use, built with TypeScript, Bun, and Effect.

The project currently has a CLI and validated configuration. ChatGPT sign-in,
conversation storage, notes tools, memory, and scheduled tasks are the next
milestones in the [implementation plan](docs/implementation-plan.md).

## Development

Use Bun 1.3.14, pinned in `mise.toml` and `package.json`.

```fish
bun install --frozen-lockfile
bun run start --help
bun run start config
bun run check
```

`bun run dev` watches the CLI source. `bun run format` formats files with Oxfmt.
`bun run lint:fix` applies safe Oxlint fixes. `bun run check` checks formatting,
linting, TypeScript, and Bun tests. GitHub Actions runs the same checks on pushes
and pull requests.

The Oxfmt and Oxlint configs are based on
[Memoir's configuration](https://github.com/tombell/memoir-app), with React and JSX
lint plugins removed for this CLI project. Type checking also covers the configuration files.

## Configuration

| Variable           | Default                  | Purpose                                                         |
| ------------------ | ------------------------ | --------------------------------------------------------------- |
| `POPPET_APP_NAME`  | `Poppet`                 | Name to use for the application and future sign-in registration |
| `POPPET_DATA_DIR`  | `~/.config/poppet`       | Future database and credential storage                          |
| `POPPET_NOTES_DIR` | `<data directory>/notes` | Future notes tools' permitted directory                         |

Paths become absolute relative to the current working directory. Explicit values
must be nonempty and have no leading or trailing whitespace. Use a full path when
configuring a directory in the environment; literal `~` is not expanded.

For example, in fish:

```fish
set -lx POPPET_DATA_DIR "$HOME/.local/share/poppet"
set -lx POPPET_NOTES_DIR "$HOME/Documents/Notes"
bun run start config
```

The `config` command prints settings. It does not create directories, open a
database, or contact OpenAI. Credentials will use separate protected storage and
will never appear in this output.

## Source layout

```text
src/
  main.ts          Bun process entry point and Effect runtime
  cli.ts           Command routing and terminal output
  config.ts        Effect Schema validation and AppConfig service/layer
  *.test.ts        Configuration and CLI behavior tests
docs/
  architecture.md  Service boundaries and Effect conventions
  implementation-plan.md
```

Modules for authentication, inference, storage, tools, memory, and scheduling will
be added as their milestones start. See the [architecture notes](docs/architecture.md)
for how they will use Effect.

## Licence

BSD 3-Clause. See [LICENSE](LICENSE).
