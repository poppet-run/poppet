import { AgentError, ChatSettings, ExternalTools } from "@poppet/agent";
import { browserInstructions, browserTools, type BrowserError } from "@poppet/browser";
import { browserSettings } from "@poppet/config";
import { MCP, MCPError, mcpInstructions } from "@poppet/mcp";
import { Console, Effect, Layer } from "effect";

const agentFailure = (error: MCPError | BrowserError) =>
  new AgentError({ reason: error.reason, message: error.message });

/** The host adapts capability-owned tools and errors to the agent's generic contract. */
export const ExternalAgentToolsLive = Layer.effect(
  ExternalTools,
  Effect.gen(function* () {
    const mcp = yield* MCP;
    const browser = yield* browserSettings;
    const { toolBytes } = yield* ChatSettings;

    return {
      instructions: browser.enabled ? `${mcpInstructions} ${browserInstructions}` : mcpInstructions,
      snapshot: (scheduled, run) =>
        Effect.gen(function* () {
          const external = yield* mcp.snapshot(scheduled).pipe(Effect.mapError(agentFailure));

          const browserCatalog =
            scheduled || !browser.enabled
              ? []
              : yield* browserTools(browser, run.runId, toolBytes).pipe(
                  Effect.catch((error) =>
                    Console.error(`Browser unavailable: ${error.message}`).pipe(Effect.as([])),
                  ),
                );

          return [...external, ...browserCatalog].map((tool) => ({
            definition: tool.definition,
            serverId: tool.serverId,
            toolName: tool.toolName,
            prepare: (argumentsJSON: string) =>
              Effect.gen(function* () {
                const call = yield* tool.prepare(argumentsJSON);

                return {
                  name: "external" as const,
                  execute: Effect.mapError(call.execute, agentFailure),
                };
              }).pipe(Effect.mapError(agentFailure)),
          }));
        }),
    };
  }),
);
