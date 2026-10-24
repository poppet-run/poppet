import { resolve } from "node:path";

import { Config, ConfigProvider, Effect, Schema } from "effect";

const Text = Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(1024));

const Id = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));

const Variable = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/));

const Names = Schema.Array(Text).check(Schema.isMaxLength(128));

/** References contain names only. Credential values stay in protected auth storage. */
export const MCPServer = Schema.Struct({
  id: Id,
  enabled: Schema.Boolean,
  command: Text,
  args: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(Schema.isMaxLength(64)),
  cwd: Schema.optionalKey(Text),
  environment: Schema.optionalKey(
    Schema.Record(
      Variable,
      Schema.Union([Schema.Struct({ env: Variable }), Schema.Struct({ credential: Id })]),
    ),
  ),
  tools: Names,
  scheduledTools: Schema.optionalKey(Names),
});

export type MCPServer = typeof MCPServer.Type;

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

      if (server.args.some((arg) => arg.includes("\0")) || server.command.includes("\0"))
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
            "Invalid mcpServers in config.json. Use unique enabled server entries, named environment/credential references and scheduledTools contained in tools. See docs/mcp.md.",
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
          server.cwd === undefined ? server : { ...server, cwd: resolve(directory, server.cwd) },
        ),
      );
