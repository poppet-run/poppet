import { AgentError, ExternalTools } from "@poppet/agent";
import { MCP, MCPError, mcpInstructions } from "@poppet/mcp";
import { Effect, Layer } from "effect";

const agentFailure = (error: MCPError) =>
  new AgentError({ reason: error.reason, message: error.message });

/** The host adapts MCP tools and errors to the agent's generic contract. */
export const ExternalAgentToolsLive = Layer.effect(
  ExternalTools,
  Effect.gen(function* () {
    const mcp = yield* MCP;

    return {
      instructions: mcpInstructions,
      snapshot: (scheduled) =>
        mcp.snapshot(scheduled).pipe(
          Effect.mapError(agentFailure),
          Effect.map((tools) =>
            tools.map((tool) => ({
              definition: tool.definition,
              serverId: tool.serverId,
              toolName: tool.toolName,
              availableAfterUntrusted: tool.availableAfterUntrusted,
              prepare: (argumentsJSON: string) =>
                Effect.gen(function* () {
                  const call = yield* tool.prepare(argumentsJSON);

                  return { execute: Effect.mapError(call.execute, agentFailure) };
                }).pipe(Effect.mapError(agentFailure)),
            })),
          ),
        ),
    };
  }),
);
