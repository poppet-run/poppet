import { inspectMCP, type MCPCommand } from "@poppet/mcp";
import { CredentialInput } from "@poppet/provider";
import { Effect, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { readHiddenKey, terminalKeyInput } from "#src/api-key-input";
import type { CLIContext } from "#src/commands/context";
import { booleanFlag, jsonFlag } from "#src/commands/flags";
import {
  addMCPServer,
  loginMCPServer,
  logoutMCPServer,
  removeMCPServer,
  changeMCPPermissions,
} from "#src/commands/mcp/setup";
import { printParsed, sections, table, tableOr, time, yesNo } from "#src/output";

const MCPServers = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    enabled: Schema.Boolean,
    state: Schema.String,
    transport: Schema.String,
    origin: Schema.NullOr(Schema.String),
    pid: Schema.NullOr(Schema.Number),
    diagnostic: Schema.NullOr(Schema.String),
    retryAt: Schema.NullOr(Schema.Number),
    tools: Schema.Array(Schema.String),
    scheduledTools: Schema.Array(Schema.String),
    availableTools: Schema.Array(Schema.String),
    signIn: Schema.NullOr(Schema.Struct({ signedIn: Schema.Boolean })),
  }),
);

const MCPTools = Schema.Array(
  Schema.Struct({
    toolName: Schema.String,
    allowed: Schema.Boolean,
    scheduled: Schema.Boolean,
    definition: Schema.NullOr(Schema.Struct({ description: Schema.String })),
  }),
);

const toolCount = (server: (typeof MCPServers.Type)[number]) => {
  const count = `${server.tools.length}/${server.availableTools.length}`;

  return server.scheduledTools.length === 0
    ? count
    : `${count} (${server.scheduledTools.length} scheduled)`;
};

const renderServers = (servers: typeof MCPServers.Type) => {
  if (servers.length === 0) return "No MCP servers. Add one with poppet mcp add.";

  const notes = servers.flatMap((server) => [
    ...(server.diagnostic === null ? [] : [`${server.id}: ${server.diagnostic}`]),
    ...(server.retryAt === null ? [] : [`${server.id}: retries after ${time(server.retryAt)}`]),
  ]);

  return sections([
    [
      null,
      table(
        ["SERVER", "STATE", "TRANSPORT", "ENDPOINT", "TOOLS ALLOWED", "SIGNED IN"],
        servers.map((server) => [
          server.id,
          server.enabled ? server.state : "disabled",
          server.transport,
          server.origin ?? (server.pid === null ? "-" : `pid ${server.pid}`),
          toolCount(server),
          server.signIn === null ? "-" : yesNo(server.signIn.signedIn),
        ]),
      ),
    ],
    notes.length === 0 ? null : ["Notes", notes.join("\n")],
  ]);
};

const renderTools = (tools: typeof MCPTools.Type) =>
  tableOr(
    "The server offers no tools.",
    ["TOOL", "ALLOWED", "SCHEDULED", "DESCRIPTION"],
    tools.map((tool) => [
      tool.toolName,
      yesNo(tool.allowed),
      yesNo(tool.scheduled),
      tool.definition?.description ?? "-",
    ]),
  );

export const mcpCommand = (context: CLIContext) => {
  const { runtime, queryWorker } = context;

  const runMCP = (command: MCPCommand, json: boolean) =>
    queryWorker(
      { kind: "mcp", command },
      inspectMCP(command).pipe(Effect.provide(runtime.mcp)),
    ).pipe(
      Effect.flatMap((result) =>
        command.action === "tools"
          ? printParsed(json, result, MCPTools, renderTools)
          : printParsed(json, result, MCPServers, renderServers),
      ),
    );

  // Setup edits config.json and protected credentials locally; a running worker keeps its
  // settings until restart.
  const setup = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(CredentialInput, {
        ...terminalKeyInput,
        readKey: (provider) =>
          readHiddenKey(
            provider,
            "API-key setup needs an interactive terminal or --api-key <key>.",
          ),
      }),
      Effect.provide([runtime.searchCredentials, runtime.mcpSignIns, runtime.config]),
    );

  const browser = Flag.Boolean("browser").pipe(
    Flag.withDescription(
      "Open the system browser; --no-browser prints the link and accepts a pasted callback address",
    ),
    Flag.atMost(1),
    Flag.map(([value = true]) => value),
  );

  return Command.make("mcp").pipe(
    Command.withDescription("Add, remove and inspect MCP servers"),
    Command.withSubcommands([
      Command.make("servers", { json: jsonFlag }, ({ json }) =>
        runMCP({ action: "servers" }, json),
      ).pipe(
        Command.withDescription("Show permissions and connection state without starting servers"),
      ),
      Command.make(
        "tools",
        { server: Argument.String("server"), json: jsonFlag },
        ({ server, json }) => runMCP({ action: "tools", server }, json),
      ).pipe(
        Command.withDescription(
          "Discover all tools and their permissions using the worker or local connections",
        ),
      ),
      Command.make(
        "add",
        {
          id: Argument.String("server"),
          url: Argument.String("url"),
          auth: Flag.Literals("auth", ["none", "api-key", "oauth"]).pipe(
            Flag.withDescription("How Poppet authenticates to the server"),
          ),
          apiKey: Flag.String("api-key").pipe(
            Flag.withDescription("API key; omit to enter it at a hidden prompt"),
            Flag.optional,
          ),
        },
        (options) => setup(addMCPServer(options)),
      ).pipe(Command.withDescription("Save a remote MCP server with no tools allowed")),
      Command.make(
        "login",
        {
          id: Argument.String("server"),
          browser,
          callbackPort: Flag.Int("callback-port").pipe(
            Flag.withDescription("Override the OAuth callback port for this sign-in"),
            Flag.optional,
          ),
        },
        ({ id, browser: open, callbackPort }) => setup(loginMCPServer(id, open, callbackPort)),
      ).pipe(Command.withDescription("Sign in to an OAuth MCP server")),
      Command.make(
        "allow",
        {
          id: Argument.String("server"),
          tools: Argument.String("tools").pipe(Argument.variadic()),
          all: booleanFlag("all", "Allow every currently discovered tool"),
          scheduled: booleanFlag("scheduled", "Also allow reviewed tools in scheduled runs"),
        },
        (options) => setup(changeMCPPermissions({ ...options, action: "allow" })),
      ).pipe(Command.withDescription("Allow discovered tools")),
      Command.make(
        "deny",
        {
          id: Argument.String("server"),
          tools: Argument.String("tools").pipe(Argument.variadic({ min: 1 })),
          scheduled: booleanFlag("scheduled", "Remove only scheduled access"),
        },
        (options) => setup(changeMCPPermissions({ ...options, all: false, action: "deny" })),
      ).pipe(Command.withDescription("Remove tool permissions")),
      Command.make("logout", { id: Argument.String("server") }, ({ id }) =>
        setup(logoutMCPServer(id)),
      ).pipe(Command.withDescription("Remove an OAuth MCP server's saved tokens")),
      Command.make("remove", { id: Argument.String("server") }, ({ id }) =>
        setup(removeMCPServer(id)),
      ).pipe(Command.withDescription("Remove an MCP server and its saved credentials")),
    ]),
  );
};
