import { inspectMCP, type MCPCommand } from "@poppet/mcp";
import { CredentialInput } from "@poppet/provider";
import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { readHiddenKey, terminalKeyInput } from "#src/api-key-input";
import type { CLIContext } from "#src/commands/context";
import { booleanFlag } from "#src/commands/flags";
import {
  addMCPServer,
  loginMCPServer,
  logoutMCPServer,
  removeMCPServer,
  changeMCPPermissions,
} from "#src/mcp-setup";

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
      Command.make("servers", {}, () => runMCP({ action: "servers" })).pipe(
        Command.withDescription("Show permissions and connection state without starting servers"),
      ),
      Command.make("tools", { server: Argument.String("server") }, ({ server }) =>
        runMCP({ action: "tools", server }),
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
