import { inspectMCP, type MCPCommand } from "@poppet/mcp";
import { CredentialInput } from "@poppet/provider";
import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { terminalKeyInput } from "#src/api-key-input";
import type { CLIContext } from "#src/commands/context";
import { booleanFlag } from "#src/commands/flags";
import { addMCPServer, loginMCPServer, logoutMCPServer, removeMCPServer } from "#src/mcp-setup";

export const mcpCommand = (context: CLIContext) => {
  const { runtime, throughWorker } = context;

  const runMCP = (command: MCPCommand) =>
    throughWorker(
      { kind: "mcp", command },
      inspectMCP(command).pipe(Effect.provide(runtime.mcp), Effect.flatMap(Console.log)),
    );

  // Setup edits config.json and protected credentials locally; a running worker keeps its
  // settings until restart.
  const setup = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(CredentialInput, terminalKeyInput),
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
      Command.make("servers", {}, () => runMCP({ action: "servers" })).pipe(
        Command.withDescription("Show permissions and connection state without starting servers"),
      ),
      Command.make("tools", { server: Argument.String("server") }, ({ server }) =>
        runMCP({ action: "tools", server }),
      ).pipe(
        Command.withDescription(
          "Discover allowed tools using the worker or scoped local connections",
        ),
      ),
      Command.make(
        "add",
        {
          id: Argument.String("server"),
          url: Flag.String("url").pipe(Flag.withDescription("Streamable HTTP endpoint")),
          auth: Flag.Literals("auth", ["none", "api-key", "oauth"]).pipe(
            Flag.withDescription("How Poppet authenticates to the server"),
          ),
          tools: Flag.String("tool").pipe(
            Flag.withDescription("Allow a discovered tool; repeat for each tool"),
            Flag.atMost(128),
          ),
          allTools: booleanFlag(
            "all-tools",
            "Allow every tool the server lists now; tools it adds later stay unallowed",
          ),
          scheduledTools: Flag.String("scheduled-tool").pipe(
            Flag.withDescription("Also allow a reviewed read-only tool in scheduled runs"),
            Flag.atMost(128),
          ),
          header: Flag.String("header").pipe(
            Flag.withDescription("Header carrying the API key (default Authorization)"),
            Flag.withDefault("Authorization"),
          ),
          prefix: Flag.String("prefix").pipe(
            Flag.withDescription('Text before the API key (default "Bearer ")'),
            Flag.withDefault("Bearer "),
          ),
          keyStdin: booleanFlag("key-stdin", "Read the API key from stdin"),
          clientId: Flag.String("client-id").pipe(
            Flag.withDescription("Pre-registered OAuth client ID; omit to register automatically"),
            Flag.optional,
          ),
          scopes: Flag.String("scope").pipe(
            Flag.withDescription("Request an OAuth scope; repeat for each scope"),
            Flag.atMost(32),
          ),
          callbackPort: Flag.Int("callback-port").pipe(
            Flag.withDescription(
              "Fixed OAuth callback port, for SSH forwarding or a registered client",
            ),
            Flag.optional,
          ),
          login: Flag.Boolean("login").pipe(
            Flag.withDescription("Sign in after saving; --no-login saves only"),
            Flag.atMost(1),
            Flag.map(([value = true]) => value),
          ),
          browser,
        },
        ({ browser: openBrowser, ...options }) => setup(addMCPServer({ ...options, openBrowser })),
      ).pipe(Command.withDescription("Add a remote MCP server and list its tools")),
      Command.make("login", { id: Argument.String("server"), browser }, ({ id, browser: open }) =>
        setup(loginMCPServer(id, open)),
      ).pipe(Command.withDescription("Sign in to an OAuth MCP server")),
      Command.make("logout", { id: Argument.String("server") }, ({ id }) =>
        setup(logoutMCPServer(id)),
      ).pipe(Command.withDescription("Remove an OAuth MCP server's saved tokens")),
      Command.make("remove", { id: Argument.String("server") }, ({ id }) =>
        setup(removeMCPServer(id)),
      ).pipe(Command.withDescription("Remove an MCP server and its saved credentials")),
    ]),
  );
};
