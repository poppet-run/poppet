import { AgentError, ChatSettings, ExternalTools } from "@poppet/agent";
import { browserInstructions, browserTools, type BrowserError } from "@poppet/browser";
import { browserSettings } from "@poppet/config";
import { MCP, MCPError, mcpInstructions } from "@poppet/mcp";
import { TaskRepository, monitorTools, monitorInstructions } from "@poppet/tasks";
import { Console, Effect, Layer } from "effect";

const agentFailure = (error: MCPError | BrowserError) =>
  new AgentError({ reason: error.reason, message: error.message });

/** The host adapts capability-owned tools and errors to the agent's generic contract. */
export const ExternalAgentToolsLive = Layer.effect(
  ExternalTools,
  Effect.gen(function* () {
    const mcp = yield* MCP;
    const tasks = yield* TaskRepository;
    const browser = yield* browserSettings;
    const { toolBytes } = yield* ChatSettings;

    return {
      instructions: `${mcpInstructions} ${browser.enabled ? browserInstructions : ""} ${monitorInstructions}`,
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

          // Browsing reads untrusted pages by design; MCP servers are withdrawn after untrusted input.
          const adapted = [
            ...external.map((tool) => ({ tool, availableAfterUntrusted: false })),
            ...browserCatalog.map((tool) => ({ tool, availableAfterUntrusted: true })),
          ].map(({ tool, availableAfterUntrusted }) => ({
            definition: tool.definition,
            serverId: tool.serverId,
            toolName: tool.toolName,
            availableAfterUntrusted,
            prepare: (argumentsJSON: string) =>
              Effect.gen(function* () {
                const call = yield* tool.prepare(argumentsJSON);

                return {
                  name: "external" as const,
                  execute: Effect.mapError(call.execute, agentFailure),
                };
              }).pipe(Effect.mapError(agentFailure)),
          }));

          return [...adapted, ...monitorTools(tasks, scheduled, run, toolBytes)];
        }),
    };
  }),
);
