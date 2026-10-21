# Development

[Documentation index](index.md)

## Commands and tooling

Use Bun 1.4.3, pinned in `mise.toml` and `package.json`.

```fish
bun install --frozen-lockfile
bun run start --help
bun run start config
bun run check
```

The repository uses Bun workspaces for `@poppet/cli`, `@poppet/config`,
`@poppet/provider`, `@poppet/provider-openai`, `@poppet/provider-opencode`,
`@poppet/provider-openrouter`, `@poppet/provider-protocol`, `@poppet/credentials`,
`@poppet/store`, `@poppet/agent`, `@poppet/mcp`, `@poppet/computer-use`,
`@poppet/memory`, `@poppet/tasks`,
`@poppet/platform`, `@poppet/platform-macos`, `@poppet/worker`, `@poppet/gateway`,
`@poppet/channel-discord`, `@poppet/channel-telegram`, and `@poppet/channel-whatsapp`.
Root `start` and `dev` commands run the CLI from the
repository directory, so relative configuration paths keep the same meaning.

`bun run dev` watches the CLI source. `bun run format` formats files with Oxfmt.
`bun run lint:fix` applies safe Oxlint fixes. `bun run check` checks formatting,
linting, types, and Bun tests. GitHub Actions runs the same checks on pushes
and pull requests. Bun's built-in type checker covers each workspace and the root
tooling configs. TypeScript stays installed for editor support. To check one
workspace, use `bun run --filter '@poppet/config' typecheck`
or `bun run --filter '@poppet/provider-openai' test`.

## Isolated tests

Use `bun run test` for the suite or `bun run test <path>` for focused tests.
The test runner starts Bun with an empty environment, a temporary home, and dotenv
loading disabled. It blocks external HTTP requests and system commands, and passes
the same guards to CLI subprocesses. Workspace test scripts use this runner too.
Direct `bun test` is rejected unless the isolation runner started it.

The root test command records file durations in `.bun-test-timings.json` so later
runs can start slower files first. This local cache is ignored by Git and can be
deleted to reset the timings. Tests still use four workers and at most two
concurrent tests per worker.

## Store migrations

Add migration SQL in a TypeScript file under `packages/store/src/migrations/`,
named `YYYYMMDDHHMMSS_description.ts` with a UTC timestamp. Import its SQL in
`packages/store/src/migrations.ts` and append an entry with the next sequential
version and a stable name. Keep applied files and registrations unchanged;
the ledger checks their names and SQL checksums before applying pending steps.

The unreleased base schema starts at version 1 with one initial migration.
Migration 2 adds monitoring to existing version-1 databases without a reset. Databases
from the former 14-step history need a fresh data directory. See
[storage](storage.md#schema-and-saved-records).

## Lint rules

The Oxfmt and Oxlint configs are based on
[Memoir's configuration](https://github.com/tombell/memoir-app), with React and JSX
lint plugins removed for this CLI project. Type checking also covers the configuration files.

Oxlint also enforces the generic and Effect rules from
[anti-slop](https://github.com/dmmulroy/anti-slop), vendored under
`tools/oxlint/anti-slop/`. These rules are errors. Keep `@oxlint/plugins` and Oxlint
at the same pinned version. See the [upstream record](../tools/oxlint/anti-slop/UPSTREAM.md)
for the source revision and update notes. Vendored code and agent tooling are
excluded from linting and formatting.

## Source layout

```text
apps/
  cli/                    @poppet/cli
    src/
      main.ts             Bun process entry point and Effect runtime
      cli.ts              Command routing and terminal output
      chat.ts             Chat commands, streaming output, session inspection
      runtime.ts          Generic selection and host configuration layers
      providers.ts        Provider registrations; first entry is the default
      channel-registry.ts Channel registrations
      channels.ts         Generic channel setup, loading, and status
      tasks.ts            Task argument parsing
      worker.ts           Worker argument parsing, launch settings, and platform selection
      worker-background.ts Background launcher, output capture, and shutdown forwarding
      worker-log.ts       Protected file writes and bounded archive retention
      worker-commands.ts  Interactive command transport and host request handling
packages/
  browser/                @poppet/browser
    src/browser.ts        Isolated per-run tools, permissions, references, result limits
    src/browser-process.ts Pinned daemon, capped probes, bounded Unix socket requests
    src/config.ts         Browser schemas and environment/file configuration
    src/errors.ts         Browser failures adapted by the host
  agent/                  @poppet/agent
    src/service.ts        Persisted chat runner, deadlines, run finalization
    src/conversation.ts   Sequential model/tool loop and run budgets
    src/reply.ts          Validated model stream completion
    src/notes.ts          Note schemas, bounded access, atomic writes
    src/memory.ts         Memory snapshots formatted into model instructions
    src/memory-tools.ts   Validated memory changes with budget checks and source runs
    src/context.ts        Complete-exchange context assembly and limits
    src/settings.ts       Validated chat budgets
  tasks/                  @poppet/tasks
    src/monitoring.ts     Validated evidence, durable comparisons, recovery projections
    src/monitor-tools.ts  Run-bound observation tool and host-owned instructions
  mcp/                    @poppet/mcp
    src/service.ts        MCP contract, scoped clients, permissions, discovery, invocation
    src/config.ts         Server schemas and environment/file configuration
    src/commands.ts       Read-only inspection commands
    src/errors.ts         MCP failures adapted by the host
    src/instructions.ts   Host-owned MCP tool policy
    src/catalog.ts        Schema validation, stable names, bounded results
    src/transport.ts      Awaited SDK stdio teardown
  computer-use/           @poppet/computer-use
    src/test/             Explicit Calculator compatibility probe, bounded policy, fixtures
  config/                 @poppet/config
    src/config.ts         Validated settings and AppConfig service/layer
  credentials/            @poppet/credentials
    src/api-keys.ts       Protected API-key storage and environment overrides
    src/lock.ts           Scoped ownership shared by credentials and SQLite storage
  memory/                 @poppet/memory
    src/service.ts        Memory service and domain errors
    src/schema.ts         Facts, snapshot data, and snapshot limits
    src/local.ts          Local fact operations and bounded snapshots
    src/context-file.ts   Bounded UTF-8 personality and profile reads
  store/                  @poppet/store
    src/database.ts       Scoped SQLite connection, ownership, and permissions
    src/migrations.ts     Ordered migrations and transactional migration ledger
    src/migrations/       Timestamped migration SQL in TypeScript files
    src/schema.ts         Durable session, message, and run schemas
    src/service.ts        Validated record operations and run lifecycle
  tasks/                  @poppet/tasks
    src/scheduler.ts      Serialized scheduled runs and wake queue
    src/commands.ts       Task operations and result inspection
    src/task-store.ts     Durable scheduling and occurrence transitions
    src/task-schema.ts    Typed commands, cron expressions, and timestamps
    src/task-socket.ts    Task command client and JSON responses
  worker/                 @poppet/worker
    src/socket.ts         Protected command transport and request ownership
  platform/               @poppet/platform
    src/index.ts          Worker actions, errors, and launch description
  platform-macos/         @poppet/platform-macos
    src/worker.ts         LaunchAgent control, plist generation, and bounded log reading
  provider/               @poppet/provider
    src/schema.ts         Normalized messages, tools, events, and continuation
    src/service.ts        Provider service, model operations, and typed errors
    src/verification.ts   Shared local tool round-trip verification
    src/registration.ts   Connection interface, provider metadata, and host services
  provider-protocol/      @poppet/provider-protocol
    src/                  Reusable Responses/Chat Completions codecs and cancellation
  provider-openai/        @poppet/provider-openai
    src/
      index.ts            Public services, live layers, and connection errors
      connection.ts       Credential schemas and redacted secrets
      auth/               Login, refresh, status, protected credential storage
      oauth/              Discovery, token exchange, JWT identity validation
      sign-in/            Browser sign-in and scoped loopback callback
      model/              Model catalog, subscription errors, verification
      registration.ts     Provider-owned live composition and connection operations
      test/fixtures/      Local OAuth and model servers for behavior tests
  provider-opencode/      @poppet/provider-opencode
    src/service.ts        Go catalog, secret configuration, and protocol routing
    src/protocol.ts       Go session headers and reasoning continuation
  provider-openrouter/    @poppet/provider-openrouter
    src/service.ts        OpenRouter catalog, capabilities, and secret configuration
    src/protocol.ts       Routing, reasoning continuation, and stream error rules
docs/                     User guides, architecture, and implementation plan
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
They do not access a ChatGPT account. Storage tests use temporary SQLite databases.
See the
[architecture notes](architecture.md) for the service boundaries.

## Adding a provider

Each provider exports a `ProviderRegistration` from its own workspace package.
Register it in `apps/cli/src/providers.ts` and declare its CLI workspace dependency.
The registration supplies the ID, display name, authentication capabilities, help,
and complete live layer. Configuration defaults to the first registered provider.

The CLI consumes shared `Provider` and `ProviderConnection` services and resolved
`ModelOperations`. Verification keeps provider resources open in its request scope.
Provider packages own authentication, environment-variable names, protocol choice,
headers, continuation extensions, and error rules. Shared credentials and protocol
helpers receive these settings from their owner. Adding a provider needs no changes
to shared schemas, storage, or command routing. Lint enforces the import boundary.
See [provider registration and ownership](architecture.md#provider-registration-and-ownership)
for the contract and integration steps.

`auth models` now returns normalized model descriptions for every provider,
including ChatGPT. Wire protocol names are internal and omitted from those descriptions.
Existing credential files and conversation records keep their formats.

## Adding a channel

Channels follow the provider registration pattern. Implement `ChannelRegistration`
from `@poppet/gateway` in the channel package, then add its registration to
`apps/cli/src/channel-registry.ts` and its workspace dependency to the CLI.
The registration supplies its ID, display name, setup usage, setup operation, and
lazy configuration loader. The CLI generates setup help and dispatches
`gateway <id> setup ...` through that registration.
Lint restricts concrete channel imports to registration modules.

The host supplies `ChannelEnvironment` with the data directory and `ChannelInput`
with bounded, redacted secret input. The package owns argument validation,
credential storage, setup messages, and connection construction. `load` returns
`null` when unconfigured or a scoped `MessagingChannel` layer when configured;
loading settings must not connect to the platform. Use a lightweight registration
entry point and import heavy SDK code only when its layer is built.

The messaging host builds a gateway per configured registration, sharing the
existing store and serialized agent. Configuration errors appear per channel and
do not prevent other configured channels from running. All resources close with
the worker. The existing Discord setup syntax and `channels/discord.json` file
remain compatible. Telegram adds a lightweight HTTP adapter for owner-only private
chat. WhatsApp uses a scoped Baileys socket and a separate protected SQLite key
store for QR-linked personal accounts. Shared `loadChannelSettings` and
`saveChannelSettings` preserve bounded reads, ownership checks, atomic replacement,
and protected file modes while adapters own their schemas.

The root `patchedDependencies` applies `patches/libsignal@6.0.0.patch` to remove
private session objects from console logs outside Baileys' logger. A subprocess
regression check exercises the installed dependency. Keep this patch when
updating the lockfile, and reassess it on dependency upgrades.

A channel can supply `poll(cursor)` instead of an event stream. Each returned item
has the next opaque cursor and either a normalized message or `null` for an
ignored update. The gateway accepts items in order and persists each cursor only
after acceptance or deliberate rejection. Errors leave the current item
unacknowledged. Keep platform offset arithmetic and filtering inside the adapter.

See [messaging package boundaries](architecture.md#package-boundaries) for the channel contract.

## Validation

Local tests cover all providers' text and tool exchanges, reasoning
continuation, output ordering, malformed and incomplete streams, cancellation,
deadlines, error classification, and provider selection. These tests do not prove
live account access. The earlier phase 1 live ChatGPT check remains separate
evidence; Go and OpenRouter inference have not been verified against live accounts.

The [notes guide](notes.md#saved-outcomes-and-recovery) and
[storage guide](storage.md#permissions-and-recovery) describe local recovery checks.
Live chat, ChatGPT token renewal, Discord, Telegram, and WhatsApp setup and reconnection, and macOS login
startup and physical sleep/wake remain separate manual checks. Follow the
[Discord guide](gateways/discord.md) and [worker manual validation](worker.md#manual-validation)
for those paths. The [implementation plan](implementation-plan.md) records
phase-specific validation and remaining work.

### Manual live test checklist

Use small prompts and the same `POPPET_DATA_DIR` throughout. Select an
assistant-capable provider and model for messaging and scheduled tasks.

- [ ] Sign in to each provider you use, select a supported model, and run
      `bun run start provider verify`. Expect inference and the tool round trip to
      succeed.
- [ ] Run `bun run start chat interactive`. Send two messages, confirm context is
      retained, then cancel a longer request with Ctrl-C. Start another chat and confirm
      it works.
- [ ] For ChatGPT, repeat a request when the access token nears expiry. Expect
      automatic renewal without signing in again.
- [ ] Test each enabled messaging adapter: Discord in an allowed thread; Telegram
      or WhatsApp in the owner's private chat. Check replies, `/status`, `/cancel`, and
      rejection of another sender. For WhatsApp self-chat, confirm replies do not
      trigger another run.
- [ ] Restart the worker and send a follow-up. Expect the same session. Briefly
      disconnect the network and restore it; check reconnection and absence of
      duplicate replies.
- [ ] Save provider/model settings in `config.json` and credentials in protected
      storage. Stop foreground workers, then run `bun run start worker install`, or
      `bun run start worker stop` followed by `bun run start worker start` for an
      existing installation. Check `bun run start worker status` and
      `bun run start worker logs`.
- [ ] Log out of macOS and back in. Confirm the worker starts automatically,
      responds to CLI commands, and receives messaging input.
- [ ] Schedule a one-off task, sleep across its due time, then wake. Expect one
      execution. Restart the worker and confirm it does not repeat; check that logs
      append without exposing secrets.
