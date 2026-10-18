import { Effect, Option, Schema } from "effect";

import { MCPError } from "#src/errors";
import { MCP } from "#src/service";

export const MCPCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literals(["servers", "status"]) }),
  Schema.Struct({ action: Schema.Literal("tools"), server: Schema.NonEmptyString }),
]);

export type MCPCommand = typeof MCPCommand.Type;

export const inspectMCP = (command: MCPCommand) =>
  Effect.gen(function* () {
    const service = yield* Effect.serviceOption(MCP);

    if (Option.isNone(service))
      return yield* Effect.fail(
        new MCPError({
          reason: "tool-permission",
          message:
            "This worker does not support MCP inspection. Restart it to load the current code.",
        }),
      );

    const value =
      command.action === "tools"
        ? yield* service.value.tools(command.server)
        : yield* service.value.status;

    return JSON.stringify(value, null, 2);
  });
