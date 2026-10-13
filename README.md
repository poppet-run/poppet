# Poppet

A small personal AI agent for local use, built with TypeScript, Bun, and Effect.

The project has a CLI, validated configuration, ChatGPT sign-in, and a shared
streaming model interface. OpenCode Go supports a small set of coding models.
OpenRouter supports concrete text models from its public catalog.
Conversation storage, notes tools, memory, and scheduled tasks
follow in the [implementation plan](docs/implementation-plan.md).

## Development

Use Bun 1.3.14, pinned in `mise.toml` and `package.json`.

```fish
bun install --frozen-lockfile
bun run start --help
bun run start config
bun run check
```

The repository uses Bun workspaces for `@poppet/cli`, `@poppet/config`,
`@poppet/provider`, `@poppet/provider-openai`, `@poppet/provider-opencode`, and `@poppet/provider-openrouter`.
Root `start` and `dev` commands run the CLI from the
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

| Variable           | Default                  | Purpose                                                     |
| ------------------ | ------------------------ | ----------------------------------------------------------- |
| `POPPET_APP_NAME`  | `Poppet`                 | Application name used for initial ChatGPT registration      |
| `POPPET_DATA_DIR`  | `~/.config/poppet`       | Credential storage and future database                      |
| `POPPET_NOTES_DIR` | `<data directory>/notes` | Future notes tools' permitted directory                     |
| `POPPET_PROVIDER`  | `openai-chatgpt`         | `openai-chatgpt`, `opencode-go`, or `openrouter`            |
| `POPPET_MODEL`     | Unset                    | Explicit model ID for provider verification and future runs |

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

## Configured providers and models

Select a provider and an explicit model. The `auth` commands remain specific to
ChatGPT and work before model selection. General provider commands use the
configured provider:

```fish
set -lx POPPET_PROVIDER openai-chatgpt
set -lx POPPET_MODEL gpt-6.1-sol
bun run start provider models
bun run start provider verify
```

`provider verify` exercises the shared message and continuation contract with
two requests and a local tool round trip. It consumes provider usage. A model
must be selected before verification opens credentials. The runtime builds only
the selected provider's dependencies and never falls back to another model.

For OpenCode Go, discovery uses its public catalog without an API key. Set
`POPPET_OPENCODE_GO_API_KEY` for inference; this secret is validated separately
and never appears in `config` output:

```fish
set -lx POPPET_PROVIDER opencode-go
set -lx POPPET_MODEL glm-5.3
set -lx POPPET_OPENCODE_GO_API_KEY '<your OpenCode Go API key>'
bun run start provider models
bun run start provider verify
```

The initial Go adapter supports `gpt-6-luna` through Responses and `glm-5.3`
through Chat Completions. Discovery lists those models when they appear in the
remote catalog. Other Go models, including the Messages protocol, are not yet
supported. Both protocols send `poppet/0.0.0` and a stable `x-opencode-session`
header for the exchange.

Go documents coding-agent traffic. Poppet's Go adapter requires a `coding`
workload and rejects general assistant, notes, and scheduled-summary requests
before reading its key or making inference requests.
[OpenCode Go requirements and endpoints](https://opencode.ai/v2/docs/console/go/)

For OpenRouter, discovery uses its public catalog without an API key. Select a
concrete model ID, then set `POPPET_OPENROUTER_API_KEY` for inference:

```fish
set -lx POPPET_PROVIDER openrouter
bun run start provider models
set -lx POPPET_MODEL anthropic/claude-sonnet-4.5
set -lx POPPET_OPENROUTER_API_KEY '<your OpenRouter API key>'
bun run start provider verify
```

Verification requires a catalog model with tool support and makes two requests
that consume OpenRouter credits. The key is redacted and omitted from `config`.
The adapter accepts both assistant and coding workloads through Chat Completions.
It derives tools, temperature, output limits, and context size from catalog
metadata. Models that generate images or audio and dynamic model routers such as
`openrouter/auto` and `openrouter/free` are excluded.

Requests require support for every requested parameter and disable provider
fallbacks. A stable `session_id` groups the exchange. Plain reasoning and the
complete structured reasoning sequence survive tool calls. Credit exhaustion,
rate limits, upstream failures, and interrupted streams produce typed errors;
requests are not automatically retried.
[OpenRouter routing](https://openrouter.ai/docs/guides/routing/provider-selection),
[reasoning continuation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens),
and [stream errors](https://openrouter.ai/docs/api/reference/streaming).

Local tests cover all providers' text and tool exchanges, reasoning
continuation, output ordering, malformed and incomplete streams, cancellation,
deadlines, error classification, and provider selection. These tests do not prove
live account access. The earlier phase 1 live ChatGPT check remains separate
evidence; Go and OpenRouter inference have not been verified against live accounts.

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
  provider/               @poppet/provider
    src/schema.ts         Normalized messages, tools, events, and continuation
    src/service.ts        Provider and selected Model services, typed errors
    src/verification.ts   Shared local tool round-trip verification
  provider-openai/        @poppet/provider-openai
    src/
      index.ts            Public services, live layers, and connection errors
      connection.ts       Credential schemas and redacted secrets
      auth/               Login, refresh, status, protected credential storage
      oauth/              Discovery, token exchange, JWT identity validation
      sign-in/            Browser sign-in and scoped loopback callback
      model/              Model catalog, SDK adapter, streams, verification
      test/fixtures/      Local OAuth and model servers for behavior tests
  provider-opencode/      @poppet/provider-opencode
    src/service.ts        Go catalog, secret configuration, and protocol routing
  provider-openrouter/    @poppet/provider-openrouter
    src/service.ts        OpenRouter catalog, capabilities, and secret configuration
docs/
  architecture.md  Service boundaries and Effect conventions
  implementation-plan.md
tools/
  oxlint/anti-slop/        Vendored lint rules
```

Each workspace declares its own dependencies. Imports between workspaces use
package names and their explicit exports. Internal imports use `#src/*`, mapped
to `./src/*.ts` by each workspace's `package.json`. For example,
`#src/auth/service` resolves to that workspace's `src/auth/service.ts`.
Shared TypeScript options live in `tsconfig.base.json`. Formatting,
linting, CI, and the lockfile remain at the root.

Auth tests use a local OAuth server with signed test identities and fake model
streams. Tests sit beside each capability. Provider suites share fixtures under
`packages/provider-openai/src/test/fixtures`.
They do not access a ChatGPT account. Modules for conversation storage,
tools, memory, and scheduling will be added as their milestones start. See the
[architecture notes](docs/architecture.md) for the service boundaries.

## Licence

BSD 3-Clause. See [LICENSE](LICENSE).
