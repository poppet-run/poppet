# Development

[Engineering notes](README.md)

## Commands and tooling

Bun 1.4.4 is pinned in `mise.toml` and `package.json`.

```sh
bun install --frozen-lockfile
bun link
poppet --help
bun run check
```

`bun link` adds `poppet` to Bun's global bin directory and points it at this
checkout, so source changes take effect without linking again. Bun must be on
`PATH` outside the checkout. With mise and no global Bun, run
`mise use -g bun@1.4.4` once. Use a disposable `POPPET_DATA_DIR` while developing
so your own data stays untouched. `bun unlink` removes the command.

| Command                                           | Does                                                           |
| ------------------------------------------------- | -------------------------------------------------------------- |
| `bun run check`                                   | Format check, lint, types, the production web build, and tests |
| `bun run format`                                  | Formats files with Oxfmt                                       |
| `bun run lint:fix`                                | Applies safe Oxlint fixes                                      |
| `bun run test <path>`                             | Runs focused tests                                             |
| `bun run --filter '@poppet/config' typecheck`     | Type-checks one workspace                                      |
| `bun run --filter '@poppet/provider-openai' test` | Tests one workspace                                            |

GitHub Actions runs `bun run check` on pushes and pull requests. The CLI and the
packages type-check with the Effect-patched compiler from `@effect/tsgo`
(`effect-tsgo tsc`), so TypeScript errors, floating Effects, and Effect warnings
and errors all fail the check. Bun's type checker covers `@poppet/web` and the
root tooling configs. The plugin options live in `tsconfig.base.json`. Editor
suggestions are not enforced. The unstable `effect/cli`, `effect/sql`,
`effect/Terminal`, `effect/reactivity`, `@effect/platform-bun`, and
`@effect/sql-sqlite-bun` modules are allowed, because Poppet is built on them.
TypeScript stays installed for editor support. The workspaces are listed in
[architecture](architecture.md#workspaces).

## Commit hook and agent guard

`bun install` runs `lefthook install` in a Git checkout, unless `CI` is set or
`.git` is missing. The pre-commit hook in `lefthook.yml` runs `bun run check`,
and a failing check blocks the commit.

`tools/hooks/hook-bypass.ts` refuses shell commands that skip or disable the hook:

- `--no-verify` and its abbreviations on any Git command, and `git commit -n`;
- `LEFTHOOK=0`, `LEFTHOOK_EXCLUDE`, and `HUSKY=0`;
- `core.hooksPath` overrides through `git -c`, `git config`, or `GIT_CONFIG_*`;
- `lefthook uninstall`, and writes under `.git/hooks`;
- any of these inside `sh -c`, `bash -c`, `eval`, or command substitution.

Claude Code (`.claude/settings.json`), Cursor (`.cursor/hooks.json`), and Codex
(`.codex/hooks.json`) run it before each shell command. Cursor and Codex run
project hooks only in a trusted workspace, and Codex asks for review of new or
changed hooks with `/hooks`. The guard stops agents only. A terminal still honours
every bypass, which is why CI runs the same checks. To try the guard:

```sh
echo '{"tool_input":{"command":"git commit --no-verify"}}' | bun tools/hooks/hook-bypass.ts
```

It prints the refusal and exits with status 2.

## Isolated tests

`bun run test` runs the suite, and `bun run test <path>` runs focused tests.
`tools/testing/run.ts` starts Bun with an empty environment, a temporary home,
and dotenv loading off. It blocks external HTTP requests and system commands, and
passes the same guards to CLI subprocesses. Workspace test scripts use it too,
and a direct `bun test` is rejected. The root command runs four workers with at
most two concurrent tests each.

- Name each test file after an existing source module.
- Use `describe` for the exact source file, function, method, or type under test.
- Name each `test` as `when <condition>, <expected result>`. Keep parameter
  values in table-driven names so a failure names its case.
- Test behaviour that callers rely on, such as permissions, saved data,
  cancellation, and recovery, through package services with explicit inputs and
  local fixtures. Keep shared protocol contract tests at the public entry point.
- CLI tests call `makeCLI` in-process for routing and output. Use subprocess tests
  only for process behaviour: stdin, terminal requirements, exit codes, signals,
  and worker ownership.
- Do not test test scaffolding or dependency bookkeeping.

Provider suites share local OAuth and model servers in
`packages/provider-openai/src/test/fixtures`, with signed test identities and
fake model streams. Storage tests use temporary SQLite databases.

## Store migrations

Each package owns its tables and its `PackageSchema`. To change a schema, append
the next migration to that package's list and raise its `version`. Never edit an
applied migration. The migrator records only IDs, so it cannot detect a changed
one. Add a `BEFORE DELETE` trigger when a new table references sessions or runs,
so [session deletion](storage.md#session-deletion) can detach it. See
[storage](storage.md#migrations) for where each package's schema lives and how
migrations run.

## Lint rules

The Oxfmt config is based on
[Memoir's configuration](https://github.com/tombell/memoir-app). Oxlint extends
[`@cloudflare/oxlint-config`](https://github.com/cloudflare/oxlint-config), which
turns off category defaults and enables rules one by one as errors. Oxlint runs
type-aware rules through `oxlint-tsgolint` with each workspace's `tsconfig.json`.
Type checking also covers the configuration files.

Rules adjusted for this stack:

| Rule                                               | Setting and reason                                  |
| -------------------------------------------------- | --------------------------------------------------- |
| `react/no-unknown-property`, `react/immutability`  | Off. `apps/web` uses Preact without React Compiler. |
| `react-hooks/rules-of-hooks`                       | Scoped to `apps/web`.                               |
| `typescript/no-misused-promises` on JSX attributes | Scoped to `apps/web`.                               |
| `unicorn/prefer-top-level-await`                   | Off. It flags `Effect.catch()`.                     |
| `@nkzw/no-instanceof`                              | Off, for Web API, error, and transport narrowing.   |
| `unicorn/catch-error-name`                         | Allows `cause` as well as `error`.                  |
| `typescript/await-thenable` in tests               | Off. Bun types async matchers as returning `void`.  |
| `typescript/no-unsafe-*` in tests                  | Off.                                                |

Oxlint also enforces the generic and Effect rules from
[anti-slop](https://github.com/dmmulroy/anti-slop), vendored under
`tools/oxlint/anti-slop/`, as errors. Rules that `@nkzw/oxlint-config`, which the
Cloudflare preset builds on, already ships as `quality/*` come from there, so
only the rest are vendored. Keep `@oxlint/plugins` and Oxlint on the same pinned
version. The [upstream record](../tools/oxlint/anti-slop/UPSTREAM.md) has the
source revision and update notes. Vendored code and agent tooling are excluded
from linting and formatting.

## Source layout

Commands with supporting modules live in `src/commands/<command>/`, where
`command.ts` defines the subcommands and tests sit beside the modules they cover.
Shared CLI code is in `src/`, and shared command helpers are in `src/commands/`.
Each package's `src/index.ts` lists its exports.

```text
apps/
  cli/                      @poppet/cli
    src/
      main.ts               Bun process entry point and Effect runtime
      cli.ts                Command tree assembly and CLI parsing
      runtime.ts            Provider selection and host configuration layers
      providers.ts          Provider registrations; the first entry is the default
      bash.ts               Bash process runner for reviewed host commands
      output.ts             Shared table, JSON, and text output
      worker-background.ts  Installed-service entry point, output capture, and shutdown forwarding
      commands/             Shared command context, flags, and single-file commands
        chat/               Chat command, streaming output, Markdown rendering, and interactive prompt
        doctor/             Read-only checks, report rendering, and worker observations
        gateway/            Gateway command, adapter setup, and registration loading
        mcp/                MCP command, setup, and agent tool wiring
        memory/             Memory command and operations
        setup/              Interactive setup command
        tasks/              Task command and argument parsing
        web-chat/           Authenticated web listener, submission receipts, and chat lifecycle
        worker/             Worker command, platform selection, host, transport, and logs
  web/                      @poppet/web, Preact browser chat and shared API types
packages/
  agent/                    @poppet/agent
    src/service.ts          Persisted chat runner, request slots, deadlines, and run finalization
    src/conversation.ts     Sequential model and tool loop, batch validation, and run budgets
    src/context.ts          Complete-exchange context assembly and limits
    src/reply.ts            Validated model stream completion
    src/settings.ts         Validated chat budgets
    src/attachments.ts      Attachment type detection and limits
    src/title.ts            Fallback and generated session titles
    src/no-reply.ts         NO_REPLY detection for conditional scheduled prompts
    src/approvals/          Reviewer requests and owner approval requests for Bash and MCP actions
    src/pages/              Supplied page reading tool, URL grants, and transport
    src/skills/             Owner skill-file access, bounded index, `$name` mentions, and view tool
    src/tools/              Tool dispatch, schemas, Bash, search, memory, task, and external tools
  config/                   @poppet/config, validated settings, quiet hours, and the AppConfig service
  credentials/              @poppet/credentials, protected API keys and records, and the ownership lock
  gateway/                  @poppet/gateway
    src/registration.ts     GatewayRegistration contract for bundled and external gateways
    src/adapter.ts          GatewayAdapter contract and incoming message types
    src/settings.ts         Shared protected settings files
    src/repository.ts       Gateway inbox, binding, and approval persistence
    src/approvals/          Approval requests and formatting for Bash and reviewed MCP actions
    src/pipeline/           Sender authorization, sessions, inbox execution, delivery, and thread naming
  gateway-discord/          @poppet/gateway-discord, Discord adapter, approvals, attachments, and setup
  gateway-slack/            @poppet/gateway-slack, Slack Socket Mode adapter, approvals, and setup
  gateway-telegram/         @poppet/gateway-telegram, Telegram Bot API adapter and settings
  io/                       @poppet/io
    src/io.ts               Bounded stream reads and subprocess cleanup
    src/budget.ts           Byte-budget text fitting
    src/files.ts            Private directories and missing-file handling
    src/log.ts              logfmt diagnostics
    src/public-url.ts       Shared HTTP URL validation and public-address policy
    src/settings.ts         Every configurable timeout and limit, with defaults and ranges
  mcp/                      @poppet/mcp
    src/service.ts          MCP contract, server registry, snapshots, and server probing
    src/connection.ts       Connection state, transport and auth wiring, and tool discovery
    src/tools.ts            Tool compilation, argument validation, and execution
    src/catalog.ts          Schema validation, stable names, and bounded results
    src/config.ts           Server schemas and environment and file configuration
    src/oauth/              OAuth sign-in, token storage, refresh, and endpoint address checks
    src/transport.ts        Scoped stdio teardown and bounded HTTP requests
    src/commands.ts         Read-only inspection commands
    src/instructions.ts     Host-owned MCP tool policy
  memory/                   @poppet/memory
    src/service.ts          Memory service and domain errors
    src/schema.ts           Facts, snapshot data, and snapshot limits
    src/local.ts            Local fact operations and bounded snapshots
    src/context-file.ts     Bounded UTF-8 personality and profile reads
  platform/                 @poppet/platform
    src/contract.ts         Worker actions, errors, status, and launch description
    src/logs.ts             Protected log creation and bounded log reading
    src/macos.ts            LaunchAgent control and plist generation
    src/linux.ts            systemd user unit control and unit file generation
  provider/                 @poppet/provider
    src/schema.ts           Normalized messages, tools, events, and continuation
    src/service.ts          Provider service, model operations, and typed errors
    src/registration.ts     Connection interface, provider metadata, and host services
    src/verification.ts     Shared local tool round-trip verification
    src/protocol/           Responses and Chat Completions codecs and cancellation
  provider-openai/          @poppet/provider-openai
    src/
      registration.ts       Provider-owned live composition and connection operations
      connection.ts         Credential schemas and redacted secrets
      auth/                 Login, refresh, status, and protected credential storage
      oauth/                Discovery, token exchange, and JWT identity validation
      sign-in/              ChatGPT authorization request and callback checks
      model/                Model catalog, subscription errors, and verification
      test/fixtures/        Local OAuth and model servers for behaviour tests
  provider-opencode/        @poppet/provider-opencode
    src/service.ts          OpenCode and OpenCode Go catalogs, keys, and protocol routing
    src/protocol.ts         Session headers and reasoning continuation
  provider-openrouter/      @poppet/provider-openrouter
    src/service.ts          OpenRouter catalog, capabilities, and key configuration
    src/protocol.ts         Routing, reasoning continuation, and stream error rules
  sign-in/                  @poppet/sign-in
    src/callback.ts         Scoped loopback callback with state and paste checks
    src/authorize.ts        Browser launch or printed link, pasted callbacks, and deadline
  store/                    @poppet/store
    src/database.ts         Scoped SQLite client, ownership, and permissions
    src/migrations.ts       PackageSchema, the migrator, and the store's schema version
    src/migrations/         Store baseline and later migrations
    src/schema.ts           Durable session, message, and run schemas
    src/service.ts          Store service and record operations
    src/sessions.ts         Session records, titles, and deletion
    src/runs.ts             Run lifecycle transitions
    src/tool-calls.ts       Tool call journal
    src/search.ts           Conversation search index queries
    src/recall.ts           Bounded session reads for conversation recall
    src/sql.ts              Row decoding helpers shared with other packages
  tasks/                    @poppet/tasks
    src/scheduler.ts        Serialized scheduled runs and wake queue
    src/task-store.ts       Durable scheduling and occurrence transitions
    src/task-controls.ts    Atomic edit, snooze, skip, and run-now transactions
    src/task-records.ts     Shared task and occurrence records
    src/task-schema.ts      Typed commands, cron expressions, and timestamps
    src/commands.ts         Task operations and result inspection
    src/chat-tools.ts       Task management for the chat tool
    src/task-socket.ts      Task command client and JSON responses
    src/migrations.ts       Task schema and migrations
  worker/                   @poppet/worker
    src/socket.ts           Protected command transport and request ownership
docs/                       Engineering notes for contributors and agents
tools/
  hooks/                    Agent hook that refuses commit-hook bypasses
  oxlint/anti-slop/         Vendored lint rules
  testing/                  Isolated test runner
```

## Adding a provider

See [adding a provider](providers.md#adding-a-provider).

## Adding a gateway

See [registration](gateways.md#registration) and the
[adapter contract](gateways.md#adapter-contract). Add a page under
`docs/gateways/` and to the website.

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
