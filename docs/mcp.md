# MCP

[Engineering notes](README.md)

Poppet is an MCP client for local stdio servers and remote Streamable HTTP
servers. It offers tools that the owner allowed by name in interactive and
scheduled runs. The [user guide](https://poppet.run/docs/mcp/) covers the `mcp`
commands.

`@poppet/mcp` owns the configuration schemas, connections, discovery, schema
validation, OAuth, inspection commands, errors, and the tool policy text. It
depends on credentials and the provider contract, and not on the agent or
application configuration. The `@poppet/mcp/config` export lets `@poppet/config`
validate the `mcpServers` section without importing the SDK.

The CLI passes the tool-result byte limit to `makeMCPLive` and adapts tools and
errors to the agent through `ExternalAgentToolsLive` in
`apps/cli/src/commands/mcp/tools.ts`. `ExternalTools` in the agent stays generic.
MCP policy comes from `mcp/src/instructions.ts`. Server instructions never reach
the model.

## Configuration

`mcpServers` in `config.json` is a list of at most 8 servers. `mcp/src/config.ts`
validates it:

- `id` is unique, lowercase, starts with a letter, and has at most 64 letters,
  digits, or hyphens.
- An entry has `command` and `args` for stdio, or `url` for HTTP, never both.
  HTTP entries take no `args`, `cwd`, or `environment`.
- `tools` lists the allowed tool names. `scheduledTools`, `reviewedTools`,
  `scheduledReviewedTools`, and `availableAfterUntrusted` are optional.
- `reviewedTools` and `scheduledTools` are disjoint subsets of `tools`.
  `scheduledReviewedTools` is a subset of `reviewedTools`.
- Secrets come only from references. `{ "env": "NAME" }` reads one environment
  variable. `{ "credential": "name" }` reads the protected file
  `auth/name.json`, which must be a `0600` regular file in a `0700` directory.
  A missing reference makes that server unavailable.

Stdio servers start with an argument array and no shell. A relative `cwd`
resolves beside `config.json`. A bare executable name uses the inherited `PATH`.
The child gets the SDK's standard environment (`HOME`, `PATH`, `USER`, `LOGNAME`,
`SHELL`, and `TERM` on macOS) plus only the named references. The worker suppresses
server stderr and does not log raw protocol failures, which may hold credentials.
The macOS LaunchAgent saves only the data directory, so an installed worker can
use credential references but not shell variables.

HTTP URLs use `https:`. Plain `http:` is allowed only for `localhost`,
`127.0.0.1`, and `[::1]`. URLs cannot hold userinfo or a fragment. Each header is
a reference with an optional non-secret `prefix`. Header values must be non-empty
visible ASCII, and header names are unique ignoring case. The transport owns
`Accept`, `Content-Type`, `Content-Length`, `Host`, `Last-Event-ID`,
`Mcp-Session-Id`, and `Mcp-Protocol-Version`, so configuration cannot set them.

`mcp add`, `mcp allow`, `mcp deny`, and `mcp remove` edit this section. `allow`
and `deny` connect only to discover names. Unknown names or failed discovery
leave permissions unchanged. `mcp allow --all` saves the names discovered now,
for interactive use only. `mcp remove` also deletes the `mcp-<id>` credential and
any saved sign-in. The worker reads configuration at start, so permission
changes need a restart.

## Connections

Both transports share one connection lifecycle in `mcp/src/connection.ts`. The
first eligible run connects lazily. The worker keeps connections across requests,
and a standalone CLI request closes them when its scope ends. A failed server
leaves built-in tools and other servers working. It reconnects on a later
eligible request after 30 seconds, doubling after each failure up to 10 minutes.
`mcp servers` shows the next `retryAt`. Nothing retries or replays a call.

Connections use the SDK's legacy initialization handshake for the 2025 protocol.
The pinned client is `@modelcontextprotocol/client` 2.4.0. Poppet supports tool
discovery and invocation only. Resources, prompts, sampling, elicitation, MCP
tasks, the legacy HTTP and SSE transport, and media forwarding are out of scope.
Resource links and media in results are marked omitted and never fetched.

HTTP adds a byte-bounded `fetch` and ends its session with `DELETE` on close.
Redirects stay within the endpoint's origin, or its HTTPS upgrade, and must keep
the method. SDK stream reconnection is off, so a dropped stream fails the
connection and the backoff reconnects with a new session.

`mcp servers` and `mcp tools` never need a model. They use the worker when it
owns the data directory, and otherwise discover in a local scope that closes the
server before returning. `servers` never launches a server. The worker socket
exposes inspection only. Calls always go through the agent's durable tool path.

## Tools and permissions

Model tool names live under `poppet_mcp` and use a stable hash of the server ID
and the original tool name. `tool_calls` stores `server_id` and `tool_name`
separately, so inspection and recovery do not need a catalog. Built-in calls
leave both null.

Each run takes a catalog snapshot. List-change notifications cannot expand it,
so discovery changes need an owner restart. Descriptions, schemas, and results
are untrusted data. Server annotations, including `readOnlyHint`, never change
permissions or review.

- Interactive runs offer allowed tools from `tools`.
- Scheduled runs offer `scheduledTools`, which the owner verified as read-only,
  and reviewed calls from `scheduledReviewedTools`.
- After a page, an MCP result, or attachments enter a run, the agent withdraws
  MCP tools for the rest of the run. A server with `availableAfterUntrusted`
  keeps its unreviewed tools. Text from earlier results can then steer that
  server's later calls within its allowlist.
- Bash output and any untrusted content withdraw reviewed tools, including calls
  queued behind those results in the same batch. `availableAfterUntrusted` never
  applies to reviewed tools.
- MCP results never grant page URLs or memory and task writes.

Poppet sends the validated arguments and the selected child credentials. It does
not attach history or memory. It redacts exact matches of resolved secret values
from returned text and structured JSON, and rejects tool definitions that contain
them.

## Reviewed actions

For a tool in `reviewedTools`, the agent reviews each call with the same reviewer
and decisions as [host commands](commands.md#review). The reviewer gets the server,
the original tool name, the validated arguments in full, and the server's
description and input schema. The escaped invocation is limited to 8 KiB and the
JSON-encoded owner message to 32 KiB. Larger requests fail before dispatch.

The journal records the decision on the pending call. Only an allowed or
owner-approved call reaches dispatch. Approval prompts show the server, tool,
target, expected effects, reason, and arguments, with long values truncated
behind **Show details**. See [owner approval](commands.md#owner-approval).

The HTTP transport binds the prepared sign-in and permits one POST for a reviewed
call. A redirect or an authorization challenge stops dispatch without a resend.
The store tells an interruption before dispatch apart from an uncertain call
already in flight.

A scheduled reviewed call is checked against the saved prompt. Only `allow`
dispatches it. Any other result fails the occurrence without an approval
prompt.

## OAuth

`mcp/src/oauth.ts` implements sign-in for entries with `"oauth": {}`.
`mcp login` discovers the authorization server from protected resource metadata,
registers a public client when the server offers dynamic registration, and opens
the browser with PKCE and a resource indicator. It uses the shared
[`@poppet/sign-in`](providers/openai-chatgpt.md#sign-in) callback, so
`--no-browser`, pasted callbacks, and SSH forwarding work as they do for ChatGPT.

- `oauth` takes optional `clientId`, `clientSecret` as a credential reference,
  `scopes`, `callbackPort` (1024 to 65535), and `resourceMetadataUrl`.
- An OAuth entry cannot also set an `Authorization` header. Other headers go to
  the MCP endpoint only.
- Without `scopes`, login requests what the metadata advertises.
- A callback `iss` must appear once and match the discovered issuer.
- A `WWW-Authenticate` resource metadata URL must share the MCP server's origin
  unless `resourceMetadataUrl` is set.
- `mcp/src/oauth/oauth-network.ts` requires public HTTPS for discovery, registration,
  and token requests, and allows plain HTTP only for loopback MCP servers. Login
  checks the browser destination before opening it.
- Client metadata documents and unattended grants are not supported.

Tokens live in `auth/mcp-oauth-<id>.json`, protected like API keys and bound to
the configured URL. A changed URL needs a new sign-in. Access tokens are redacted
from results and rejected in tool definitions. Logout deletes tokens, keeps the
registration, and does not revoke the grant.

A run never opens a browser. When a server rejects an access token, the client
claims a short refresh lease and releases the file lock before calling the
authorization server. A worker and a CLI process adopt the same refreshed token,
and a late rejection of the old token keeps the newer sign-in. A rejected or
missing refresh token, a missing sign-in, or a changed URL puts the server in
`needs-login`. Its tools become unavailable with no backoff, and the next request
after `mcp login` reconnects, including in a running worker. A request for more
scope fails that call with a diagnostic naming the scope. Active connections
check the saved sign-in before each request, so logout blocks further calls
without a restart. `mcp servers` reports `signIn` with `signedIn`, `expiresAt`,
and granted `scopes`, never tokens.

## Bounds

| Bound                                                    | Limit                        | Setting                       |
| -------------------------------------------------------- | ---------------------------- | ----------------------------- |
| Configured servers                                       | 8                            | Fixed                         |
| Discovery pages per server                               | 8                            | Fixed                         |
| Discovered tools per server                              | 128                          | `limits.mcpTools`             |
| Discovery JSON per server                                | 256 KiB                      | `limits.mcpDiscoveryBytes`    |
| Stdio read buffer, HTTP JSON body, HTTP error, SSE event | 4 MiB                        | Fixed                         |
| OAuth response                                           | 256 KiB                      | Fixed                         |
| One SSE response                                         | 16 MiB                       | Fixed                         |
| Tool description                                         | 4096 characters              | Fixed                         |
| Input or output schema                                   | 16 KiB, depth 32, 1024 nodes | Fixed                         |
| Arguments                                                | 64 KiB                       | Fixed                         |
| Startup and discovery                                    | 8 seconds per server         | `timeouts.mcpStartupSeconds`  |
| Connection and each tool-list request                    | 5 seconds                    | `timeouts.mcpConnectSeconds`  |
| Invocation                                               | 10 seconds                   | `timeouts.mcpToolCallSeconds` |
| Stdio cleanup after closing stdin                        | 5 seconds, then signals      | Fixed                         |
| HTTP session `DELETE`                                    | 5 seconds, then abort        | Fixed                         |
| Serialized result                                        | 16 KiB                       | `limits.toolBytes`            |

An oversized protocol message closes the connection. Tool definitions count
toward the context budget, and calls share the run's tool-call budget and batch
validation.

## Schemas

`mcp/src/catalog.ts` validates schemas with AJV. It picks draft-07 or 2020-12
from `$schema`. Without one, modern keywords such as `dependentRequired` select
2020-12. Validation covers the standard JSON Schema and OpenAPI formats: `date`,
`time`, `date-time`, `duration`, `uri`, `uri-reference`, `uri-template`, `email`,
`hostname`, `ipv4`, `ipv6`, `uuid`, `json-pointer`, `relative-json-pointer`,
`regex`, `byte`, `int32`, `int64`, `float`, `double`, `password`, and `binary`.
Patterns use RE2 through `re2-wasm`, so lookarounds and backreferences fail, and
some Unicode matching differs from JavaScript. Vendor `x-` keywords are ignored,
but `x-` property names are still validated.

These make a tool unavailable, with a diagnostic naming the tool and schema:

- `$ref`, `patternProperties`, or an unsupported format or keyword
- a description over the limit
- required MCP task execution

The server's other tools stay available. `mcp servers` lists skipped tools in its
notes.

Models see a strict object with one required `input` string that holds the JSON
arguments. Poppet decodes it and validates the object against the server's
original schema, without defaults, coercion, or dropping unknown fields. Optional
server fields stay optional even for strict-schema providers.

## Results and failures

Results fit the 16 KiB budget. Text is shortened on Unicode boundaries, and
oversized structured JSON is omitted whole. Results report `truncated`,
`omittedContent`, `omittedStructuredContent`, and `redacted`.

A tool-reported error leaves a failed call. A transport or protocol failure after
dispatch, or cancellation while a call runs, leaves it uncertain. Nothing replays
an uncertain call, including after a restart.
