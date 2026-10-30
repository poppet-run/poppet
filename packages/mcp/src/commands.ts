import { Effect, Schema } from "effect";

import { MCP } from "#src/service";

export const MCPCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("servers") }),
  Schema.Struct({ action: Schema.Literal("tools"), server: Schema.NonEmptyString }),
]);

export type MCPCommand = typeof MCPCommand.Type;

/** Server status or one server's tools, as plain data for the caller to format. */
export const inspectMCP = (command: MCPCommand) =>
  Effect.gen(function* () {
    const service = yield* MCP;

    return command.action === "tools"
      ? yield* service.tools(command.server)
      : yield* service.status;
  });
