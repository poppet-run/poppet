import { resolve } from "node:path";

import { Config, ConfigProvider, Effect, Schema } from "effect";

const Text = Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(1024));

const Id = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));

const Variable = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/));

const Names = Schema.Array(Text).check(Schema.isMaxLength(128));

const Reference = Schema.Union([
  Schema.Struct({ env: Variable }),
  Schema.Struct({ credential: Id }),
]);

export type MCPReference = typeof Reference.Type;

// The transport sets these itself; a configured value would break or spoof the protocol.
const managedHeaders = new Set([
  "accept",
  "content-length",
  "content-type",
  "host",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
]);

const HeaderName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9-]{1,128}$/),
  Schema.makeFilter((name) =>
    managedHeaders.has(name.toLowerCase()) ? "MCP transport headers cannot be configured." : true,
  ),
);

const HeaderPrefix = Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^[ -~]*$/));

const HeaderReference = Schema.Union([
  Schema.Struct({ env: Variable, prefix: Schema.optionalKey(HeaderPrefix) }),
  Schema.Struct({ credential: Id, prefix: Schema.optionalKey(HeaderPrefix) }),
]);

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** HTTPS endpoints, or plain HTTP to this machine. Secrets belong in headers, not the URL. */
const Endpoint = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value) => {
    if (!URL.canParse(value)) return "MCP server URLs must be absolute.";
    const url = new URL(value);

    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback.has(url.hostname)))
      return "MCP server URLs must use https, or http to a loopback address.";

    if (url.username !== "" || url.password !== "" || url.hash !== "")
      return "MCP server URLs cannot contain credentials or fragments.";

    return true;
  }),
);

const shared = {
  id: Id,
  enabled: Schema.Boolean,
  tools: Names,
  scheduledTools: Schema.optionalKey(Names),
};

/** References contain names only. Credential values stay in protected auth storage. */
export const MCPStdioServer = Schema.Struct({
  ...shared,
  command: Text,
  args: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(Schema.isMaxLength(64)),
  cwd: Schema.optionalKey(Text),
  environment: Schema.optionalKey(Schema.Record(Variable, Reference)),
});

export const MCPHTTPServer = Schema.Struct({
  ...shared,
  url: Endpoint,
  headers: Schema.optionalKey(Schema.Record(HeaderName, HeaderReference)),
});

export const MCPServer = Schema.Union([MCPStdioServer, MCPHTTPServer]);

export type MCPServer = typeof MCPServer.Type;

export type MCPHTTPServer = typeof MCPHTTPServer.Type;

export type MCPStdioServer = typeof MCPStdioServer.Type;

export const isHTTPServer = (server: MCPServer): server is MCPHTTPServer => "url" in server;

export const MCPServers = Schema.Array(MCPServer).check(
  Schema.isMaxLength(8),
  Schema.makeFilter((servers) => {
    if (new Set(servers.map((server) => server.id)).size !== servers.length)
      return "MCP server IDs must be unique.";

    for (const server of servers) {
      if (
        new Set(server.tools).size !== server.tools.length ||
        new Set(server.scheduledTools ?? []).size !== (server.scheduledTools ?? []).length ||
        server.scheduledTools?.some((name) => !server.tools.includes(name))
      )
        return "Scheduled MCP tools must be a unique, owner-reviewed read-only subset of tools.";

      if (isHTTPServer(server)) {
        const names = Object.keys(server.headers ?? {}).map((name) => name.toLowerCase());

        if (new Set(names).size !== names.length) return "MCP header names must be unique.";
      } else if (server.args.some((arg) => arg.includes("\0")) || server.command.includes("\0"))
        return "MCP commands and arguments cannot contain NUL.";
    }

    return true;
  }),
);

/** Server entries supplied by the host configuration file. */
export const mcpServers = Config.String("mcpServers").pipe(
  Config.withDefault("[]"),
  Effect.flatMap((json) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(MCPServers), { onExcessProperty: "error" })(
      json,
    ),
  ),
  Effect.mapError(
    () =>
      new Config.ConfigError(
        new ConfigProvider.SourceError({
          message:
            "Invalid mcpServers in config.json. Use unique enabled server entries with either a command or an https url, named environment/credential/header references and scheduledTools contained in tools. See docs/mcp.md.",
        }),
      ),
  ),
);

/** Working-directory paths resolve beside config.json. */
export const mcpFileValue = (servers: ReadonlyArray<MCPServer> | undefined, directory: string) =>
  servers === undefined
    ? undefined
    : JSON.stringify(
        servers.map((server) =>
          isHTTPServer(server) || server.cwd === undefined
            ? server
            : { ...server, cwd: resolve(directory, server.cwd) },
        ),
      );
