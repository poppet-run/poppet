# MCP tools

[Documentation index](README.md)

Poppet can connect to local stdio MCP servers and remote Streamable HTTP servers
and offer explicitly allowed tools in CLI, messaging, and scheduled runs. MCP is
disabled until you add an enabled server to `config.json`. Local servers execute
code with your account's permissions; remote servers receive the arguments and
headers you select. Review and trust the executable or endpoint before enabling
it. Tool allowlists do not provide an operating-system sandbox.

The `@poppet/mcp` workspace owns the client runtime, server configuration schemas,
inspection commands, errors, and prompt policy. The CLI supplies configuration
and limits and adapts allowed tools to the agent's generic external-tool hook.

It has separate configuration, run-owned resources, and no scheduled access. It
is not a generic MCP server entry or part of the MCP allowlist.

## Configure a server

Add `mcpServers` to your existing `<data directory>/config.json`:

```json
{
  "mcpServers": [
    {
      "id": "reference",
      "enabled": true,
      "command": "/absolute/path/to/trusted-server",
      "args": ["--stdio"],
      "cwd": "server-data",
      "environment": {
        "API_TOKEN": { "env": "REFERENCE_API_TOKEN" }
      },
      "tools": ["lookup_record"],
      "scheduledTools": []
    }
  ]
}
```

Replace the executable, arguments, and tool names with your server's values.
`args` and `tools` are required arrays; `cwd`, `environment`, `scheduledTools`,
and `availableAfterUntrusted` are optional. IDs must be unique lowercase names beginning with a letter, with
letters, digits, and hyphens thereafter, at most 64 characters. Commands run with
an argument array and no shell. Install servers yourself. Never put secret values
in commands, arguments, or general configuration.

Relative file-configured working directories resolve beside `config.json`.
Without `cwd`, the server uses Poppet's working directory. An executable name
without a path uses the inherited `PATH`. Prefer an absolute executable path for
a background worker.

### HTTP servers

Add a remote server from the CLI:

```sh
poppet mcp add remote https://mcp.example.com/mcp --auth api-key
poppet mcp tools remote
poppet mcp allow remote lookup_record
```

`add` saves an enabled server with no tools allowed and does not connect to it.
`--auth` is required: `none` sends no credentials, `api-key` reads a key
from a hidden prompt or `--api-key <key>`, saves it as the protected credential
`mcp-<id>`, and sends it as `Authorization: Bearer <key>`. `oauth` configures
OAuth for a separate `mcp login` step.

`mcp tools <id>` discovers tools and shows their `allowed` and `scheduled`
permissions. `mcp allow <id> <tools...>` adds discovered names to the interactive
allowlist. `mcp allow <id> --all` saves all names discovered now; tools the
server adds later remain blocked. It cannot be combined with explicit names
or `--scheduled`. Use `mcp allow <id> <tools...> --scheduled` for explicitly
reviewed read-only tools; this grants both interactive and scheduled access.
Unknown tools and failed discovery leave permissions unchanged.

`mcp deny <id> <tools...>` removes both permissions without connecting to the
server. Add `--scheduled` to remove only scheduled access. These commands work
with both HTTP and configured stdio servers. Restart the worker after adding,
removing, or changing permissions. Until then inspection through that worker
reflects its existing configuration.

Custom API-key header names and prefixes belong in `headers` in `config.json`.
For example, use `"X-API-Key": { "credential": "mcp-remote" }` instead of the
Authorization entry for an unprefixed key. `poppet mcp remove <id>` deletes
the entry, its `mcp-<id>` credential, and any saved sign-in.

An entry with `url` instead of `command` connects over Streamable HTTP:

```json
{
  "id": "remote",
  "enabled": true,
  "url": "https://mcp.example.com/mcp",
  "headers": {
    "Authorization": { "credential": "remote", "prefix": "Bearer " },
    "X-Team": { "env": "REMOTE_TEAM" }
  },
  "tools": ["lookup_record"],
  "scheduledTools": []
}
```

An entry has either `command` or `url`, never both, and HTTP entries take no
`args`, `cwd`, or `environment`. URLs must use `https:`; plain `http:` is
accepted only for `localhost`, `127.0.0.1`, and `[::1]`. URLs cannot contain a
username, password, or fragment. Put secrets in `headers`, not the path or
query, which server logs may record.

Each header names an `{ "env": "NAME" }` or `{ "credential": "name" }` reference,
as for stdio environments, with an optional non-secret `prefix` such as
`"Bearer "`. Values must be non-empty visible ASCII. Header names are unique
regardless of case. `Accept`, `Content-Type`, `Content-Length`, `Host`,
`Last-Event-ID`, `Mcp-Session-Id`, and `Mcp-Protocol-Version` belong to the
transport and cannot be configured. A missing reference makes that server
unavailable. Resolved header values are redacted from results and rejected in
tool definitions, like selected environment values.

### OAuth sign-in

```sh
poppet mcp add notes https://mcp.example.com/mcp --auth oauth
poppet mcp login notes
poppet mcp tools notes
poppet mcp allow notes search
```

`add` saves `"oauth": {}` in the entry. `login` starts sign-in and discovers the
server's authorization server from its protected resource metadata, registers
itself as a public client when the authorization server offers dynamic
registration, and opens the browser with PKCE and a resource indicator. The
callback, `--no-browser`, pasted callback addresses, and SSH forwarding work as
for [ChatGPT sign-in](providers/openai-chatgpt.md). `login --no-browser` prints
the sign-in link. Run `poppet mcp login <id>` to sign in again and
`poppet mcp logout <id>` to delete tokens while keeping the registration;
logging out does not revoke the grant at the authorization server.

`oauth` accepts optional `clientId`, `clientSecret` (a `{ "credential": "name" }`
reference, never a literal), `scopes`, and `callbackPort` (1024–65535) in
`config.json`. `mcp login <id> --callback-port <port>` overrides the port for
that sign-in without changing configuration. Use a pre-registered
client when the authorization server has no dynamic registration; register a
fixed loopback redirect such as `http://127.0.0.1:1455/auth/callback` and set
the same `callbackPort`. Without `scopes`, Poppet requests what the server's
metadata advertises. An OAuth entry cannot also configure an `Authorization`
header; other headers are sent only to the MCP endpoint. Client metadata
documents and unattended grants are unsupported.

Tokens live in `<data directory>/auth/mcp-oauth-<id>.json`, protected like API
keys and bound to the configured URL: changing the URL requires a new sign-in.
Discovery, registration, and token requests use HTTPS (plain HTTP only to
loopback) and the same size cap as MCP messages. Access tokens are redacted
from results and rejected in tool definitions.

A run never opens a browser. When the server rejects an access token, Poppet
refreshes it under the record's lock; a worker and a CLI process never both
spend one refresh token, and the second adopts the first's result. A rejected
or missing refresh token, a missing sign-in, or a changed URL puts the server in
`needs-login`: its tools are unavailable, other servers keep working, and no
backoff applies. The next request after `mcp login` reconnects, including in a
running worker. A server asking for more scope fails that call with a
diagnostic naming the scope; add it to `scopes` and sign in again.
`mcp servers` reports `signIn` with `signedIn`, `expiresAt`, and granted
`scopes`, never token values. Active connections check saved sign-in before
sending requests, so logout blocks further calls without restarting the worker.
Calls already sent before logout may still complete.

Set `mcpServers` to `[]` in `config.json` to disable every server. Worker settings
change after restart, including allowlist changes.

Children receive the SDK's small standard environment containing `HOME`, `PATH`,
`USER`, `LOGNAME`, `SHELL`, and `TERM` on macOS, plus only your named references.
They do not inherit all provider keys or channel tokens. `{ "env": "NAME" }`
selects one environment value. `{ "credential": "name" }` selects an existing
protected API-key entry from `<data directory>/auth/name.json`. Its format is
`{"version":1,"provider":"name","key":"<secret>"}`. Provision it separately,
with a `0700` auth directory and a `0600` regular file; symlinks are rejected.
MCP inspection does not create or write credentials. Missing selected references
make that server unavailable.

The macOS LaunchAgent saves only the data directory, so shell secret variables
are unavailable to an installed worker. Use protected credential references for
that worker. Selected values are never added to model instructions; exact matches
in returned text or structured JSON are redacted. Poppet suppresses server stderr
and avoids logging raw protocol failures, which may contain credentials.

## Inspect and use tools

```sh
poppet mcp servers
poppet mcp tools reference
poppet chat new "Use reference to look up record 123"
```

`servers` shows configured permissions, transport, connection state,
PID (stdio only), the HTTP endpoint's origin, available tools, and diagnostics. They never launch servers or require a model.
`tools <server>` explicitly starts discovery when needed and prints every discovered
tool with `allowed` and `scheduled` permission flags. Allowed tools include their
model definitions; blocked tools have `definition: null`. Both commands use
the owning worker when available. Without a worker, discovery uses a local scope
and closes the server before returning. There is no arbitrary tool-execution
socket command.

The first eligible agent run connects lazily. The worker retains its connections
across requests; a standalone CLI request closes them when its scope ends. A
server failure leaves built-in tools available. A failed server reconnects on a
later eligible request after 30 seconds, doubling after each failed reconnection
to at most 10 minutes; `mcp servers` shows the next `retryAt`. Calls are never
automatically retried or replayed.

Model tool names use a stable hash of the server ID and original tool name under
`poppet_mcp`. `chat show <session>` retains `serverId` and `toolName` separately,
so inspection and recovery do not depend on a discovery catalog.

## Permissions and untrusted content

Only discovered names in `tools` are offered. Interactive mutations also need
your current explicit request. `scheduledTools` is empty by default and must be a
subset of `tools` that you have reviewed as read-only. Server annotations cannot
grant scheduled access. Poppet cannot verify that a server implements its tools
honestly.

Each run takes a catalog snapshot. List-change notifications cannot expand it;
restart the owner to refresh discovery. Server instructions are ignored.
Descriptions, schemas, and results remain untrusted data. They cannot authorize
memory or task mutations, expand permissions, or grant URL access.

Once a fetched page, search result, or MCP result enters a run, MCP tools are
withdrawn for the rest of it, so each run makes at most one round of MCP calls.
Set `"availableAfterUntrusted": true` on a server whose workflow needs several
calls, such as reading its own docs before running code. Its allowed tools then
stay available after untrusted content; task and memory tools are still
withdrawn. Only opt in a server you trust with that content: text from an email,
page, or earlier result can then steer that server's later calls in the same
run, limited to its `tools` (or `scheduledTools` in scheduled runs). URLs
returned by MCP do not receive web-search grants. Scheduled runs retain the
built-in mutation restrictions. Poppet sends the validated arguments and selected
child credentials, without automatically attaching history or global memory.

## Bounds and schema compatibility

The official TypeScript client SDK is pinned at 2.3.1 and exercised under Bun 1.4.4.
Connections use the SDK's legacy initialization handshake for the 2025 protocol.
Poppet supports tool discovery and invocation only. The legacy HTTP+SSE
transport, resources, prompts, sampling, elicitation, MCP tasks, and media
forwarding are outside this implementation. Resource links and media are marked omitted and never fetched.

- At most 8 configured servers, 8 discovery pages per server, 128 discovered tools,
  and 256 KiB of discovery JSON per server.
- Each stdio read buffer is capped at 256 KiB, before JSON parsing. HTTP JSON
  bodies and individual SSE events have the same cap while streaming. Oversized
  protocol messages close the connection.
- HTTP redirects are followed only within the endpoint's origin (or its HTTPS
  upgrade) and only when they keep the method. The SDK's stream reconnection is
  off: a dropped stream fails the connection, and Poppet's backoff reconnects it
  with a new session.
- Allowed descriptions are at most 4096 characters; input/output schemas are at
  most 16 KiB, depth 16, and 512 nodes. Draft-07 and 2020-12 schemas are validated
  with AJV. Valid required-only union branches retain their runtime assertions.
  Patterns use the non-backtracking RE2 engine; lookarounds and backreferences
  are unsupported, and some Unicode matching differs from JavaScript regexes.
  References, `patternProperties`, and unsupported formats or keywords fail
  discovery with a diagnostic naming the tool and input/output schema. Without
  `$schema`, modern keywords such as `dependentRequired` select 2020-12;
  otherwise draft-07 is used. Explicit dialect declarations take precedence. Vendor `x-` keywords, such as FastMCP's
  `x-fastmcp-wrap-result`, are ignored; `x-` property names are still validated.
  Required MCP task execution is unsupported.
- Models receive a strict object containing one required `input` string. That
  string contains the original JSON arguments. Poppet validates the decoded object
  against the original server schema, without adding defaults, coercing values,
  or dropping unknown fields. Optional server fields therefore remain optional
  even with a strict-schema provider. Arguments are capped at 64 KiB.
- Tool definitions count toward the existing context budget. Calls share the
  existing run and tool-call budgets and whole-batch preflight validation.
- Startup and discovery together have an 8-second deadline per server, with a
  5-second protocol-request deadline. Invocation has a 10-second deadline. Process
  cleanup can take another 5 seconds while stdin closure escalates to signals.
  HTTP cleanup sends the session `DELETE` within 5 seconds, then aborts open requests.
- Serialized results fit the 16 KiB tool-output limit. Text is shortened without splitting
  Unicode; oversized structured JSON is omitted as a whole. Results explicitly
  report `truncated`, `omittedContent`, `omittedStructuredContent`, and `redacted`.

Tool-reported errors leave a failed durable call. Transport/protocol failures
following dispatch leave an uncertain call, as does cancellation while a call is
running. An uncertain call may have changed external state. Inspect that server's
state before explicitly requesting another attempt, including after a restart.

## Manual validation

Automated tests use fixture stdio and in-process HTTP servers and injected models. With one trusted
real server, inspect its allowed catalog, complete a real-model tool round trip
from the CLI and an authorized messaging conversation, and inspect `chat show`.
Then allow one reviewed read in `scheduledTools`, restart the worker, schedule
that read, and inspect its result. Stop the worker and confirm its MCP PIDs have
exited. These stdio checks passed on 2026-10-27.

With one trusted remote server that accepts a bearer token, configure the
token as a protected credential header, inspect its catalog from the worker, and
complete a CLI tool round trip. This remote check passed on 2026-10-27.

With one real OAuth server that supports dynamic registration, add it with
`--auth oauth`, run `mcp login <id> --no-browser`, and sign in over SSH with a pasted callback, complete a CLI and
a worker tool round trip, wait for or force token expiry and confirm the next
call refreshes, then log out and confirm `mcp servers` shows `needs-login`.
Fixture tests do not establish that a real authorization server interoperates;
this check has not been run.
