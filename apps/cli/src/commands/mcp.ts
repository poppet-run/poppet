import { inspectMCP, type MCPCommand } from "@poppet/mcp";
import { Console, Effect } from "effect";
import { Argument, Command } from "effect/cli";

import type { CLIContext } from "#src/commands/context";

export const mcpCommand = (context: CLIContext) => {
  const { runtime, throughWorker } = context;

  const runMCP = (command: MCPCommand) =>
    throughWorker(
      { kind: "mcp", command },
      inspectMCP(command).pipe(Effect.provide(runtime.mcp), Effect.flatMap(Console.log)),
    );

  return Command.make("mcp").pipe(
    Command.withDescription("Inspect configured local MCP servers"),
    Command.withSubcommands([
      ...(["servers", "status"] as const).map((action) =>
        Command.make(action, {}, () => runMCP({ action })).pipe(
          Command.withDescription("Show permissions and connection state without starting servers"),
        ),
      ),
      Command.make("tools", { server: Argument.String("server") }, ({ server }) =>
        runMCP({ action: "tools", server }),
      ).pipe(
        Command.withDescription(
          "Discover allowed tools using the worker or scoped local connections",
        ),
      ),
    ]),
  );
};
