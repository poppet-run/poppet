# MCP tools

[Documentation index](index.md)

Poppet can connect to local stdio MCP servers and offer explicitly allowed tools
in CLI, messaging, and scheduled runs. MCP is disabled until you add an enabled
server to `config.json`. Servers execute code with your account's permissions.
Review and trust the executable before enabling it. Tool allowlists do not provide
an operating-system sandbox.

The `@poppet/mcp` workspace owns the client runtime, server configuration schemas,
inspection commands, errors, and prompt policy. The CLI supplies configuration
and limits and adapts allowed tools to the agent's generic external-tool hook.

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
`args` and `tools` are required arrays; `cwd`, `environment`, and `scheduledTools`
are optional. IDs must be unique lowercase names beginning with a letter, with
letters, digits, and hyphens thereafter, at most 64 characters. Commands run with
an argument array and no shell. Install servers yourself. Never put secret values
in commands, arguments, or general configuration.

Relative file-configured working directories resolve beside `config.json`.
Without `cwd`, the server uses Poppet's working directory. An executable name
without a path uses the inherited `PATH`. Prefer an absolute executable path for
a background worker.

`POPPET_MCP_SERVERS` accepts a JSON array and replaces the entire file-configured
list. Setting it to `[]` disables every server for that process. Environment paths
resolve against that process's working directory. Worker settings change after
restart, including allowlist changes.

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

```fish
bun run start mcp servers
bun run start mcp status
bun run start mcp tools reference
bun run start chat new "Use reference to look up record 123"
```

`servers` and `status` show configured permissions, connection state, PID,
available tools, and diagnostics. They never launch servers or require a model.
`tools <server>` explicitly starts discovery when needed and prints only allowed
tools, their model definitions, and scheduled permissions. All three commands use
the owning worker when available. Without a worker, discovery uses a local scope
and closes the server before returning. There is no arbitrary tool-execution
socket command.

The first eligible agent run connects lazily. The worker retains its connections
across requests; a standalone CLI request closes them when its scope ends. A
server failure leaves built-in tools available. Failed connections remain
unavailable until the owning process restarts. Calls are never automatically
retried or replayed.

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
note, memory, or task mutations, expand permissions, or grant URL access. URLs
returned by MCP do not receive web-search grants. Scheduled runs retain the
built-in mutation restrictions. Poppet sends the validated arguments and selected
child credentials, without automatically attaching history or global memory.

## Bounds and schema compatibility

The official TypeScript client SDK is pinned at 2.3.1 and exercised under Bun 1.4.3.
Connections use the SDK's legacy initialization handshake for the 2025 protocol.
Poppet supports tool discovery and invocation only. Remote HTTP/OAuth, resources,
prompts, sampling, elicitation, MCP tasks, and media forwarding are outside this
implementation. Resource links and media are marked omitted and never fetched.

- At most 8 configured servers, 8 discovery pages per server, 128 discovered tools,
  and 256 KiB of discovery JSON per server.
- Each stdio read buffer is capped at 256 KiB, before JSON parsing. Oversized
  protocol messages close the connection.
- Allowed descriptions are at most 4096 characters; input/output schemas are at
  most 16 KiB, depth 16, and 512 nodes. Draft-07 and 2020-12 schemas are validated
  with AJV. References, regular expressions, and unsupported formats or keywords
  fail discovery with a diagnostic. Required MCP task execution is unsupported.
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
- Serialized results fit `POPPET_TOOL_BYTES`. Text is shortened without splitting
  Unicode; oversized structured JSON is omitted as a whole. Results explicitly
  report `truncated`, `omittedContent`, `omittedStructuredContent`, and `redacted`.

Tool-reported errors leave a failed durable call. Transport/protocol failures
following dispatch leave an uncertain call, as does cancellation while a call is
running. An uncertain call may have changed external state. Inspect that server's
state before explicitly requesting another attempt, including after a restart.

## Manual validation

Automated tests use a fixture stdio server and injected models. With one trusted
real server, inspect its allowed catalog, complete a real-model tool round trip
from the CLI and an authorized messaging conversation, and inspect `chat show`.
Then allow one reviewed read in `scheduledTools`, restart the worker, schedule
that read, and inspect its result. Stop the worker and confirm its MCP PIDs have
exited. These live checks remain manual.
