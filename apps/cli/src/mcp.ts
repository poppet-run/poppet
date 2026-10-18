import { AgentError, ExternalTools } from "@poppet/agent";
import { MCP, MCPError, mcpInstructions } from "@poppet/mcp";
import { Effect, Layer } from "effect";

const agentFailure = (error: MCPError) =>
  new AgentError({ reason: error.reason, message: error.message });

/** Only the host knows both the MCP client and the agent's generic tool contract. */
export const MCPAgentToolsLive = Layer.effect(
  ExternalTools,
  Effect.gen(function* () {
    const mcp = yield* MCP;

    return {
      instructions: mcpInstructions,
      snapshot: (scheduled) =>
        mcp.snapshot(scheduled).pipe(
          Effect.map((catalog) =>
            catalog.map((tool) => ({
              definition: tool.definition,
              serverId: tool.serverId,
              toolName: tool.toolName,
              prepare: (argumentsJSON: string) =>
                tool.prepare(argumentsJSON).pipe(
                  Effect.map((call) => ({
                    name: "external" as const,
                    execute: call.execute.pipe(Effect.mapError(agentFailure)),
                  })),
                  Effect.mapError(agentFailure),
                ),
            })),
          ),
          Effect.mapError(agentFailure),
        ),
    };
  }),
);
