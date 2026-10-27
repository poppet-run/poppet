# Development

[Documentation index](README.md)

## Commands and tooling

Use Bun 1.4.4, pinned in `mise.toml` and `package.json`.

```sh
bun install --frozen-lockfile
bun link
poppet --help
poppet config
bun run check
```

The repository uses Bun workspaces for `@poppet/cli`, `@poppet/config`,
`@poppet/provider`, `@poppet/provider-openai`, `@poppet/provider-opencode`,
`@poppet/provider-openrouter`, `@poppet/credentials`,
`@poppet/store`, `@poppet/agent`, `@poppet/browser`, `@poppet/io`, `@poppet/mcp`,
`@poppet/memory`, `@poppet/skills`, `@poppet/tasks`, `@poppet/web-search`,
`@poppet/platform`, `@poppet/platform-macos`, `@poppet/platform-linux`, `@poppet/worker`, `@poppet/gateway`,
`@poppet/channel-discord`.
`bun run format` formats files with Oxfmt.
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

Name each test file after an existing source module. Test current functions and
services through behavior users rely on, including permissions, saved data,
cancellation, and recovery. Keep shared protocol contract tests at the public
entry point. Avoid tests of test scaffolding or dependency bookkeeping.

Use `describe` for the exact source filename, function, method, or type under test.
Name each `test` as `when <condition>, <expected result>`, keeping parameter values
in table-driven names so failures identify the case.

Prefer testing behaviour through package services with explicit inputs and local
fixtures. CLI tests call `makeCLI` in-process for command routing and output.
Keep subprocess tests for process behaviour such as stdin, terminal requirements,
exit codes, signals, and worker ownership. The isolation runner applies to all
tests, including package tests that launch subprocesses.

The root test command uses four workers and at most two concurrent tests per
worker.

## Store migrations

Each package owns its tables. The store defines conversations in
`packages/store/src/migrations/0001_baseline.ts`; memory, tasks, and gateway
define theirs in their own `src/migrations.ts`. Each exports a `PackageSchema`
with its own ledger table, version, and migrations keyed `<id>_<name>`, one SQL
statement per array entry. Each package's layer calls `migrate` from
`@poppet/store` when it starts, after the store has migrated its own tables.
The gateway migrates the task schema first because it reads task occurrences.

To change a package's schema, append the next migration and raise its `version`.
Never edit an applied migration: the migrator records only IDs, so it cannot
detect a changed one. Each package's pending migrations run in one transaction.

Development databases created before the baseline are refused and need a fresh
data directory. See [storage](storage.md#schema-and-saved-records).

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
      cli.ts              Command tree assembly and CLI parsing
      commands/           Per-area command trees, runners, shared context, and flags
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
    src/tool-execution.ts Tool dispatch, outcomes, and journal writes
    src/skills.ts         Owner skill-file access
    src/skill-index.ts    Bounded skill descriptions and indexing
    src/skill-tools.ts    Skill view and management tools
    src/reply.ts          Validated model stream completion
    src/memory.ts         Memory snapshots formatted into model instructions
    src/context-files.ts  Shared bounded skill/project file access
    src/memory-tools.ts   Validated memory changes with budget checks and source runs
    src/context.ts        Complete-exchange context assembly and limits
    src/settings.ts       Validated chat budgets
    src/web-search.ts     Search tool definition and model argument validation
  web-search/             @poppet/web-search
    src/web-search.ts     Search service, shared HTTP handling, bounded results
    src/brave.ts          Brave Search adapter
    src/kagi.ts           Kagi v1 Search adapter
    src/errors.ts         Search failures adapted by the agent
  io/                     @poppet/io
    src/io.ts             Bounded stream reads and subprocess cleanup
    src/public-url.ts     Shared HTTP URL validation and public-address policy
  mcp/                    @poppet/mcp
    src/service.ts        MCP contract, scoped clients, permissions, discovery, invocation
    src/config.ts         Server schemas and environment/file configuration
    src/commands.ts       Read-only inspection commands
    src/errors.ts         MCP failures adapted by the host
    src/instructions.ts   Host-owned MCP tool policy
    src/catalog.ts        Schema validation, stable names, bounded results
    src/transport.ts      Awaited SDK stdio teardown
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
    src/database.ts       Scoped SQLite client, ownership, permissions, migration
    src/migrations.ts     Registered migrations and the current schema version
    src/migrations/       Baseline schema and later migrations
    src/sql.ts            Row decoding helpers shared with other packages
    src/schema.ts         Durable session, message, and run schemas
    src/service.ts        Validated record operations and run lifecycle
  tasks/                  @poppet/tasks
    src/scheduler.ts      Serialized scheduled runs and wake queue
    src/commands.ts       Task operations and result inspection
    src/task-store.ts     Durable scheduling and occurrence transitions
    src/task-controls.ts  Atomic edit, snooze, skip, and run-now transactions
    src/task-records.ts   Shared task and occurrence records
    src/task-schema.ts    Typed commands, cron expressions, and timestamps
    src/task-socket.ts    Task command client and JSON responses
  worker/                 @poppet/worker
    src/socket.ts         Protected command transport and request ownership
  platform/               @poppet/platform
    src/contract.ts       Worker actions, errors, status, and launch description
    src/logs.ts           Protected log creation and bounded log reading
  platform-macos/         @poppet/platform-macos
    src/worker.ts         LaunchAgent control and plist generation
  platform-linux/         @poppet/platform-linux
    src/worker.ts         systemd user unit control and unit file generation
  provider/               @poppet/provider
    src/schema.ts         Normalized messages, tools, events, and continuation
    src/service.ts        Provider service, model operations, and typed errors
    src/verification.ts   Shared local tool round-trip verification
    src/registration.ts   Connection interface, provider metadata, and host services
    src/protocol/         Responses/Chat Completions codecs and cancellation
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

`provider models` now returns normalized model descriptions for every provider,
including ChatGPT. Wire protocol names are internal and omitted from those descriptions.
Existing credential files and conversation records keep their formats.

## Adding a channel

Discord is the only bundled channel. External packages implement `ChannelRegistration`
from `@poppet/gateway` and export it as the default export of a lightweight entry point.
Install the package in `<POPPET_DATA_DIR>/gateways`, then list its entry point in
`config.json`, for example:

```json
{
  "gatewayPackages": ["@example/poppet-chat/registration"]
}
```

The example is a placeholder, not a published adapter. Poppet resolves packages
from that directory, independently of the working directory. Package names and
package subpaths are accepted; file paths and URLs are rejected. Nothing is
automatically discovered or installed. Discord is always registered; duplicate
or reserved IDs and malformed registrations stop gateway startup with an error.
Restart the worker after changing the list or installed packages.

Gateway commands and messaging worker startup load the same registrations.
Other CLI commands and tasks-only workers do not import external adapter code.
External modules run with the host's privileges. Use the host's compatible
`@poppet/gateway` and Effect versions; these packages are currently private
workspaces, so publishing a standalone adapter still requires packaging those
shared dependencies. The loader does not provide dependency isolation.

The registration supplies its ID, display name, setup usage, setup operation, and
lazy configuration loader. The CLI generates setup help and dispatches
`gateway <id> setup ...` through that registration.
Lint restricts concrete channel imports to registration modules.

The optional `promptSetup` operation collects interactive choices and returns a
save effect, or `null` when skipped. The host runs that effect after collecting
the remaining choices. `poppet setup` currently uses only the bundled Discord
registration and does not load external adapters.

The host supplies `ChannelEnvironment` with the data directory and `ChannelInput`
with bounded, redacted secret input. The package owns argument validation,
credential storage, setup messages, and connection construction. `load` returns
`null` when unconfigured or a scoped `MessagingChannel` layer when configured;
loading settings must not connect to the platform. Use a lightweight registration
entry point and import heavy SDK code only when its layer is built.

The messaging host builds a gateway per configured registration, sharing the
existing store and serialized agent. Configuration errors appear per channel and
do not prevent other configured channels from running. All resources close with
the worker. Discord keeps ordinary settings in `config.json` and only its token
in `channels/discord.json`. Its `accountId` effect resolves when Discord reports
the authenticated bot identity; status remains available while login retries.
The channel policy limits incoming requests to one owner and scope. Adapters
validate platform permissions in `checkAccess`. An optional `homeConversationId`
supplies the default proactive destination; `destination` resolves its parent.

To receive files, an adapter lists them in `IncomingMessage.attachments` and
implements `download`. Each attachment has the platform's ID, a display name, an
optional size the platform reports before download, and `ref`, the adapter's own
locator such as a URL or file ID; the gateway never reads it. The gateway calls
`download(attachment, maxBytes)` when the request runs, so `ref` must still
resolve then. `download` must stop at `maxBytes` bytes received, and fail with
`unavailable` or `uncertain` to retry or with any other reason to refuse the file
with a reply. Without `download`, a message with files gets a reply that the
channel cannot receive them. The agent identifies file types and applies limits
for every channel. A platform that delivers file bytes inline with the message,
with nothing to fetch later, is not yet supported.
Shared `loadChannelSettings` and `saveChannelSettings` preserve
bounded reads, ownership checks, atomic replacement, and protected file modes
while adapters own their schemas.

See [messaging package boundaries](architecture.md#package-boundaries) for the channel contract.

## Validation

Local tests cover all providers' text and tool exchanges, reasoning
continuation, output ordering, malformed and incomplete streams, cancellation,
deadlines, error classification, and provider selection. These tests do not prove
live account access. Live ChatGPT subscription inference and a tool round trip
passed on 2026-10-13; Go and OpenRouter inference have not been verified against live accounts.

The [storage guide](storage.md#permissions-and-recovery) describes local recovery checks.
Live chat, ChatGPT token renewal, Discord setup and reconnection, macOS and Linux login
startup and physical sleep/wake remain separate manual checks. Follow the
[Discord guide](gateways/discord.md) and [worker manual validation](worker.md#manual-validation)
for those paths. The [implementation plan](implementation-plan.md) lists
planned work.

### Manual live test checklist

Use small prompts and the same `POPPET_DATA_DIR` throughout. Select an
assistant-capable provider and model for messaging and scheduled tasks.

- [ ] Sign in to each provider you use, select a supported model, and start a
      chat. Ask it to use a local read-only tool and expect inference and the tool round trip to succeed.
- [ ] Run `poppet chat interactive`. Send two messages, confirm context is
      retained, then cancel a longer request with Ctrl-C. Start another chat and confirm
      it works.
- [ ] For ChatGPT, repeat a request when the access token nears expiry. Expect
      automatic renewal without signing in again.
- [ ] Test Discord in an allowed thread. Check replies, `/status`, `/cancel`, and
      rejection of another sender.
- [ ] Restart the worker and send a follow-up. Expect the same session. Briefly
      disconnect the network and restore it; check reconnection and absence of
      duplicate replies.
- [ ] Save provider/model settings in `config.json` and credentials in protected
      storage. Stop foreground workers, then run `poppet worker install`, or
      `poppet worker stop` followed by `poppet worker start` for an
      existing installation. Check `poppet worker status` and
      `poppet worker logs`.
- [ ] Log out of macOS and back in. Confirm the worker starts automatically,
      responds to CLI commands, and receives messaging input.
- [ ] Schedule a one-off task, sleep across its due time, then wake. Expect one
      execution. Restart the worker and confirm it does not repeat; check that logs
      append without exposing secrets.
