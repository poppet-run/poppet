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
`@poppet/store`, `@poppet/agent`, `@poppet/io`, `@poppet/mcp`,
`@poppet/memory`, `@poppet/tasks`,
`@poppet/platform`, `@poppet/worker`, `@poppet/gateway`,
`@poppet/gateway-discord`, `@poppet/gateway-slack`, `@poppet/gateway-telegram`, and
`@poppet/web`.
Skills live inside `@poppet/agent`.
`bun run format` formats files with Oxfmt.
`bun run lint:fix` applies safe Oxlint fixes. `bun run check` checks formatting,
linting, types, the production web build, and Bun tests. GitHub Actions runs the
same checks on pushes and pull requests. Bun's built-in type checker covers the root
tooling configs and `@poppet/web`. The CLI and workspace packages run the Effect-patched
TypeScript compiler from `@effect/tsgo` (`effect-tsgo tsc`), so TypeScript errors, floating
Effects, Effect warnings, and Effect errors all fail the check. The plugin options live in
`tsconfig.base.json`; suggestions are left to the
editor, and the unstable `effect/cli`, `effect/sql`, `effect/Terminal`, `effect/reactivity`,
`@effect/platform-bun`, and `@effect/sql-sqlite-bun` modules are allowed because Poppet is
built on them. TypeScript stays installed for editor support. To check one
workspace, use `bun run --filter '@poppet/config' typecheck`
or `bun run --filter '@poppet/provider-openai' test`.

## Commit hook and agent guard

`bun install` runs `lefthook install` in local Git checkouts (skipped when `CI` is set or
`.git` is absent), which adds a pre-commit hook that runs
`bun run check` (see `lefthook.yml`). A failing check blocks the commit.

`tools/hooks/hook-bypass.ts` refuses shell commands that skip or disable that hook:
`--no-verify` and its abbreviations on any Git command, `git commit -n`, `LEFTHOOK=0`,
`LEFTHOOK_EXCLUDE`, `HUSKY=0`, `core.hooksPath` overrides through `git -c`, `git config`,
or `GIT_CONFIG_*` variables, `lefthook uninstall`, and writes under `.git/hooks`, including
inside `sh -c`, `bash -c`, `eval`, and command substitutions. Claude Code
(`.claude/settings.json`), Cursor (`.cursor/hooks.json`), and Codex (`.codex/hooks.json`)
run it before each shell command. Cursor and Codex run project hooks only in a trusted
workspace, and Codex asks you to review new or changed hooks with `/hooks`.

The guard only stops agents inside those harnesses. A terminal still honours every
bypass, so CI runs the same checks on every pull request. To check the guard, pipe a
command into it:

```sh
echo '{"tool_input":{"command":"git commit --no-verify"}}' | bun tools/hooks/hook-bypass.ts
```

It prints the refusal and exits with status 2.

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

The Oxfmt config is based on
[Memoir's configuration](https://github.com/tombell/memoir-app). Oxlint extends
[`@cloudflare/oxlint-config`](https://github.com/cloudflare/oxlint-config), which disables
category defaults and enables rules explicitly as errors. Type checking also covers the
configuration files.

Oxlint runs type-aware rules through `oxlint-tsgolint`, using each workspace's
`tsconfig.json`. A few preset rules are adjusted for this stack: `react/no-unknown-property` and
`react/immutability` stay off because `apps/web` uses Preact without React Compiler,
`react-hooks/rules-of-hooks` and JSX attribute `typescript/no-misused-promises` are scoped to
`apps/web`, `unicorn/prefer-top-level-await` stays off because it flags `Effect.catch()`,
`@nkzw/no-instanceof` stays off for Web API and error/transport narrowing, and
`unicorn/catch-error-name` allows `cause` alongside `error`. Test files turn off
`typescript/await-thenable` (Bun types async matchers as returning `void`) and the remaining
`typescript/no-unsafe-*` rules.

Oxlint also enforces the generic and Effect rules from
[anti-slop](https://github.com/dmmulroy/anti-slop), vendored under
`tools/oxlint/anti-slop/`. These rules are errors. Rules that `@nkzw/oxlint-config` already
ships as `quality/*` come from that config instead, so only the rest are vendored. Keep
`@oxlint/plugins` and Oxlint at the same pinned version. See the
[upstream record](../tools/oxlint/anti-slop/UPSTREAM.md)
for the source revision and update notes. Vendored code and agent tooling are
excluded from linting and formatting.

## Source layout

Commands with supporting modules live under `src/commands/<command>/`, with
`command.ts` defining the command tree and tests alongside the modules they cover.
Shared CLI code stays in `src/`; shared command helpers stay in `src/commands/`.

```text
apps/
  web/                    @poppet/web, Preact browser chat and shared API types
  cli/                    @poppet/cli
    src/
      main.ts             Bun process entry point and Effect runtime
      cli.ts              Command tree assembly and CLI parsing
      commands/           Shared command context, flags, and single-file commands
        chat/             Chat command, streaming output, and interactive prompt
        doctor/           Read-only checks, report rendering, and worker observations
        gateway/          Gateway command, adapter setup, and registrations
        mcp/              MCP command, setup, and agent tool wiring
        memory/           Memory command and operations
        setup/            Interactive setup command
        tasks/            Task command and argument parsing
        web-chat/         Authenticated web listener, submission receipts, and chat lifecycle
        worker/           Worker command, platform selection, host, transport, and logs
      runtime.ts          Generic selection and host configuration layers
      providers.ts        Provider registrations; first entry is the default
      worker-background.ts Stable installed-service entry point, output capture, and shutdown forwarding
packages/
  gateway/                @poppet/gateway, shared acceptance, approvals, and delivery
  gateway-discord/        @poppet/gateway-discord, Discord adapter and setup
  gateway-slack/          @poppet/gateway-slack, Slack Socket Mode adapter and setup
  gateway-telegram/       @poppet/gateway-telegram, Telegram Bot API adapter and setup
  agent/                  @poppet/agent
    src/service.ts        Persisted chat runner, deadlines, run finalization
    src/conversation.ts   Sequential model/tool loop and run budgets
    src/tool-execution.ts Tool dispatch, outcomes, and journal writes
    src/skills.ts         Owner skill-file access
    src/skill-index.ts    Bounded skill descriptions and indexing
    src/skill-tools.ts    Skill view and management tools
    src/skill-mentions.ts Skills named with $name in a message
    src/reply.ts          Validated model stream completion
    src/memory.ts         Memory snapshots formatted into model instructions
    src/context-files.ts  Shared bounded skill/project file access
    src/memory-tools.ts   Validated memory changes with budget checks and source runs
    src/context.ts        Complete-exchange context assembly and limits
    src/settings.ts       Validated chat budgets
  io/                     @poppet/io
    src/io.ts             Bounded stream reads and subprocess cleanup
    src/public-url.ts     Shared HTTP URL validation and public-address policy
  mcp/                    @poppet/mcp
    src/service.ts        MCP contract, server registry, snapshots, and server probing
    src/connection.ts     Connection state, transport/auth wiring, and tool discovery
    src/tools.ts          Tool compilation, argument validation, and execution
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
    src/macos.ts          LaunchAgent control and plist generation
    src/linux.ts          systemd user unit control and unit file generation
  sign-in/                @poppet/sign-in
    src/callback.ts       Scoped loopback callback with state and paste checks
    src/authorize.ts      Browser launch or printed link, pasted callbacks, deadline
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
      sign-in/            ChatGPT authorization request and callback checks
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

## Adding a gateway

Discord, Slack, and Telegram are bundled gateways. External packages implement `GatewayRegistration`
from `@poppet/gateway` and export it as the default export of a lightweight entry point.
Install the package in `<POPPET_DATA_DIR>/gateways`, then list its entry point in
`config.json`, for example:

```json
{
  "gatewayPackages": ["@example/poppet-chat/registration"]
}
```

The example is a placeholder, not a published adapter. Poppet resolves packages
from that directory, independently of the working directory. The install directory
and package entry points must be owned by the Poppet user and writable only by
that user. Entry points resolve inside its local `node_modules` directory.
Package names and
package subpaths are accepted; file paths and URLs are rejected. Nothing is
automatically discovered or installed. Discord, Slack, and Telegram are always registered; duplicate
or reserved IDs and malformed registrations stop gateway startup with an error.
Restart the worker after changing the list or installed packages.

Gateway commands and messaging worker startup load the same registrations.
Help shows the bundled gateways without importing external adapter code.
External modules run with the host's privileges. Use the host's compatible
`@poppet/gateway` and Effect versions; these packages are currently private
workspaces, so publishing a standalone adapter still requires packaging those
shared dependencies. The loader does not provide dependency isolation.

The registration supplies its ID, display name, setup usage, setup operation, and
lazy configuration loader. The CLI generates setup help and dispatches
`gateway <id> setup ...` through that registration.
Lint restricts concrete gateway imports to registration modules.

The optional `promptSetup` operation collects interactive choices and returns a
save effect, or `null` when skipped. The host runs that effect after collecting
the remaining choices. `poppet setup` uses the bundled Discord and Slack
registrations and does not load external adapters.

The host supplies `GatewayEnvironment` with the data directory and `GatewayInput`
with bounded, redacted secret input. The package owns argument validation,
credential storage, setup messages, and connection construction. `load` returns
`null` when unconfigured or a scoped `GatewayAdapter` layer when configured;
loading settings must not connect to the platform. Use a lightweight registration
entry point and import heavy SDK code only when its layer is built.

The messaging host builds a gateway per configured registration, sharing the
existing store and agent request slots. Requests within one session stay ordered. Configuration errors appear per channel and
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
Shared `loadGatewaySettings` and `saveGatewaySettings` preserve
bounded reads, ownership checks, atomic replacement, and protected file modes
while adapters own their schemas.

See [messaging package boundaries](architecture.md#package-boundaries) for the gateway contract.

## Validation

Automated tests use local fixtures and controlled providers. They do not contact a
live account, a real messaging platform, or a real MCP server, and they do not
exercise launchd, systemd, or physical sleep. Run the manual checks below for
changes in those areas. Planned work is tracked in
[GitHub issues](https://github.com/poppet-run/poppet/issues).

### Manual live test checklist

Use a disposable `POPPET_DATA_DIR`, small prompts, and an assistant-capable
provider and model throughout.

Providers and chat:

- [ ] Sign in to each provider you changed, select a model, and start a chat.
      Ask for a local read-only tool and expect inference and the tool round trip
      to succeed.
- [ ] Run `poppet chat`. Send two messages and confirm the second answer uses the
      first. Draft while a response streams, attach a file, resize the terminal,
      and exit. Resume the printed session ID, interrupt one request with Ctrl-C,
      and inspect it with `chat show`.
- [ ] Send a screenshot and a log file in one message with `chat new --attach`
      and in a Discord thread. Send an image over 5 MiB, and send an image to a
      text-only model. Expect each refusal to name the file.
- [ ] Ask the model to remember one fact, then replace it, then forget it. After
      each step, inspect `memory list` and `chat show`, including from a fresh
      chat.
- [ ] For ChatGPT, repeat a request when the access token nears expiry. Expect
      renewal without signing in again.

Host commands:

- [ ] In Discord, ask for a harmless filesystem check and verify its Bash
      receipt. Request an operation whose review asks for approval and deny it
      with the button. Confirm no command ran and the buttons are disabled.
- [ ] Repeat with **Approve once**, then check `/approve <id>` and `/deny <id>`
      on new requests. Check that another account cannot answer, and that expiry
      and `/cancel` disable the controls. Restart the worker and confirm an old
      request stays unusable.
- [ ] In Slack, repeat approval and denial with the text controls in the
      original thread.
- [ ] Schedule a command that needs approval. Expect a logged failure with no
      execution and no approval prompt, the reason in `tasks show`, and a fixed
      failure notice when the task has a messaging destination.

Messaging gateways:

- [ ] In an allowed Discord thread, check replies, `/status`, `/cancel`, and the
      rejection of another sender. Mention the bot in a channel while another
      thread's request runs, and confirm replies within one thread stay in order
      and cancelling one thread leaves the other running.
- [ ] In the private Discord test channel, check thread creation and renaming,
      and rename a thread by hand while the bot renames it.
- [ ] Start a messaging session with `/new --skill <name>` and send a follow-up.
      Expect the skill to stay selected.
- [ ] In Slack, check mentions and thread replies, owner rejection, attachments,
      cancellation, scheduled results, and failure notices.
- [ ] Restart the worker and send a follow-up. Expect the same session.
      Disconnect the network briefly and confirm reconnection without duplicate
      replies.

MCP servers:

- [ ] With one trusted stdio server, inspect its allowed catalog, complete a tool
      round trip from the CLI and from an authorized messaging conversation, and
      inspect `chat show`. Add one read to `scheduledTools`, restart the worker,
      schedule that read, and inspect its result. Stop the worker and confirm the
      server processes exited.
- [ ] With one remote server that accepts a bearer token, configure the token as a
      protected credential header, inspect its catalog from the worker, and
      complete a CLI tool round trip.
- [ ] With one OAuth server that supports dynamic registration, add it with
      `--auth oauth`, run `mcp login <id> --no-browser` over SSH with a pasted
      callback, and complete a CLI and a worker tool round trip. Wait for or force
      token expiry and confirm the next call refreshes. Log out and confirm
      `mcp servers` shows `needs-login`.

Scheduled tasks and the worker:

- [ ] Save the provider and model in `config.json`, then run `poppet worker
      install`, or `poppet worker restart` for an existing installation. Check
      `worker status` and `worker logs`.
- [ ] Schedule a one-off task a minute ahead with `tasks add --at`. Sleep across
      its due time, then wake. Expect one execution. Restart the worker and
      confirm it does not run again, and that logs append without secrets.
- [ ] Edit a task, skip its next run, run it now, and snooze a one-off across a
      worker restart. Expect task IDs and history to stay, the cron cadence to
      hold, and the snoozed run to happen once. Repeat the controls through CLI
      chat and an authorized Discord thread, and check receipts and delivery.
- [ ] Log out of macOS and back in. Confirm the worker starts, answers CLI
      commands, and receives messaging input.
- [ ] On Linux, log out and back in with and without lingering. Kill the launcher
      and confirm systemd restarts it after 30 seconds.

Web chat:

- [ ] Sign in over HTTPS from a desktop and a phone. Send a message and compare
      the reply on both.
- [ ] Refresh or close a page mid-reply, then reopen the conversation on either
      device. Draft while a reply streams, scroll up, and confirm new output does
      not move the view.
- [ ] Disconnect during submission, reconnect, and recover it. Confirm the
      conversation has one input.
- [ ] Stop a reply and inspect it with `chat show`. Restart the worker during
      another reply and confirm it is interrupted and not retried.
- [ ] Delete a conversation. Confirm it leaves the sidebar on both devices and
      that the other device shows "Conversation not found." if it had it open.
- [ ] Check the mobile keyboard, multiline input, the sidebar, long code blocks,
      and sign-out.

Doctor:

- [ ] Run `poppet doctor` with the worker stopped, then with a worker running
      from the same configuration. Check human and JSON output. Change one setting
      while the worker runs and confirm doctor reports the mismatch. Break
      `config.json` and confirm independent checks still appear. Compare files and
      permissions before and after each run. Doctor must not launch tools, refresh
      credentials, create files, or repair anything.
