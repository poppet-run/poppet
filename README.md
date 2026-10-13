# Poppet

A small personal AI agent for local use, built with TypeScript, Bun, and Effect.

The project has a CLI, validated configuration, and ChatGPT sign-in with a
subscription verification command. Conversation storage, notes tools, memory, and scheduled tasks
follow in the [implementation plan](docs/implementation-plan.md).

## Development

Use Bun 1.3.14, pinned in `mise.toml` and `package.json`.

```fish
bun install --frozen-lockfile
bun run start --help
bun run start config
bun run check
```

The repository uses Bun workspaces for `@poppet/cli`, `@poppet/config`, and
`@poppet/provider-openai`. Root `start` and `dev` commands run the CLI from the
repository directory, so relative configuration paths keep the same meaning.

`bun run dev` watches the CLI source. `bun run format` formats files with Oxfmt.
`bun run lint:fix` applies safe Oxlint fixes. `bun run check` checks formatting,
linting, TypeScript, and Bun tests. GitHub Actions runs the same checks on pushes
and pull requests. Type checking covers each workspace and the root tooling
configs. To check one workspace, use `bun run --filter '@poppet/config' typecheck`
or `bun run --filter '@poppet/provider-openai' test`.

The Oxfmt and Oxlint configs are based on
[Memoir's configuration](https://github.com/tombell/memoir-app), with React and JSX
lint plugins removed for this CLI project. Type checking also covers the configuration files.

Oxlint also enforces the generic and Effect rules from
[anti-slop](https://github.com/dmmulroy/anti-slop), vendored under
`tools/oxlint/anti-slop/`. These rules are errors. Keep `@oxlint/plugins` and Oxlint
at the same pinned version. See the [upstream record](tools/oxlint/anti-slop/UPSTREAM.md)
for the source revision and update notes. Vendored code and agent tooling are
excluded from linting and formatting.

## Configuration

| Variable           | Default                  | Purpose                                                |
| ------------------ | ------------------------ | ------------------------------------------------------ |
| `POPPET_APP_NAME`  | `Poppet`                 | Application name used for initial ChatGPT registration |
| `POPPET_DATA_DIR`  | `~/.config/poppet`       | Credential storage and future database                 |
| `POPPET_NOTES_DIR` | `<data directory>/notes` | Future notes tools' permitted directory                |

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
database, or contact OpenAI. Credentials use separate protected storage and never
appear in this output.

## ChatGPT connection

Sign in through the system browser, then verify subscription access:

```fish
bun run start auth login
bun run start auth models
bun run start auth verify
bun run start auth status
```

Initial sign-in registers Poppet with its own host identifier and issued client
ID. The browser handles account and workspace selection and plan-usage consent.
The local callback displays a confirmation page before its listener closes.
Return to the terminal for the final identity and permission checks.
Later sign-ins reuse the registration and host identifier. Poppet currently stores
one account and rejects a returning identity that does not match it.
[OpenAI registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)

`auth verify` selects the first visible model in the account's catalog. Pass a
model slug from `auth models` to choose another, for example
`bun run start auth verify <slug>`. Verification makes two streamed Responses
requests, which consume ChatGPT plan usage. It requests a local tool, supplies a
random token as the tool result, and requires the completed answer to return that
token. Success records the model and verification time; it does not guarantee
future quota or eligibility.
[Subscription inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

If identity sign-in succeeds without plan-usage permission, status reports
`planUsage: false`. Run `bun run start auth login --consent` to request consent
again. Usage limits, ineligible accounts, temporary failures, and interrupted
streams produce separate errors. Model requests are not automatically retried.
The flow uses OAuth credentials and requires no API key or client secret.

Credentials live in `<POPPET_DATA_DIR>/auth/connection.json`, with owner-only file
permissions (`0600`) inside a protected directory (`0700`). Writes use atomic
replacement. Tokens are redacted in application values and omitted from command
output. Near-expiry access tokens are refreshed with rotating credentials saved
together. An exclusive `auth/owner.lock` prevents concurrent authentication
commands and is removed on normal shutdown or interruption. After a process
crash, remove a remaining lock only after confirming no Poppet auth command is
running.

`bun run start auth logout` attempts remote revocation and clears local tokens,
while retaining the host identifier and registration. If remote revocation cannot
be confirmed, the command reports this so you can disconnect Poppet in ChatGPT
Settings.

## Source layout

```text
apps/
  cli/                    @poppet/cli
    src/
      main.ts             Bun process entry point and Effect runtime
      cli.ts              Command routing and terminal output
      runtime.ts          Composition of authentication and model layers
packages/
  config/                 @poppet/config
    src/config.ts         Validated settings and AppConfig service/layer
  provider-openai/        @poppet/provider-openai
    src/
      index.ts            Public services, live layers, and connection errors
      connection.ts       Credential schemas and redacted secrets
      auth/               Login, refresh, status, protected credential storage
      oauth/              Discovery, token exchange, JWT identity validation
      sign-in/            Browser sign-in and scoped loopback callback
      model/              Model catalog, SDK adapter, streams, verification
      test/fixtures/      Local OAuth and model servers for behavior tests
docs/
  architecture.md  Service boundaries and Effect conventions
  implementation-plan.md
tools/
  oxlint/anti-slop/        Vendored lint rules
```

Each workspace declares its own dependencies. Imports between workspaces use
package names and their explicit exports; relative imports stay within a
workspace. Shared TypeScript options live in `tsconfig.base.json`. Formatting,
linting, CI, and the lockfile remain at the root.

Auth tests use a local OAuth server with signed test identities and fake model
streams. Tests sit beside each capability. Provider suites share fixtures under
`packages/provider-openai/src/test/fixtures`.
They do not access a ChatGPT account. Modules for conversation storage,
tools, memory, and scheduling will be added as their milestones start. See the
[architecture notes](docs/architecture.md) for the service boundaries.

## Licence

BSD 3-Clause. See [LICENSE](LICENSE).
