import { Effect, Schema } from "effect";

import { MCP } from "#src/service";

export const MCPCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literals(["servers", "status"]) }),
  Schema.Struct({ action: Schema.Literal("tools"), server: Schema.NonEmptyString }),
]);

export type MCPCommand = typeof MCPCommand.Type;

export const inspectMCP = (command: MCPCommand) =>
  Effect.gen(function* () {
    const service = yield* MCP;

    const value =
      command.action === "tools" ? yield* service.tools(command.server) : yield* service.status;

    return JSON.stringify(value, null, 2);
  });
