import { AgentError, ChatSettings, ExternalTools } from "@poppet/agent";
import { browserInstructions, browserTools, type BrowserError } from "@poppet/browser";
import {
  computerInstructions,
  computerTools,
  ComputerTarget,
  validateComputerTrial,
  type ComputerError,
} from "@poppet/computer-use";
import { AppConfig, browserSettings, computerSettings, webSearchEnabled } from "@poppet/config";
import { MCP, MCPError, mcpInstructions, mcpServers } from "@poppet/mcp";
import { Memory } from "@poppet/memory";
import { TaskRepository } from "@poppet/tasks";
import { Console, Effect, Layer, Option } from "effect";

const agentFailure = (error: MCPError | BrowserError | ComputerError) =>
  new AgentError({ reason: error.reason, message: error.message });

/** The host adapts capability-owned tools and errors to the agent's generic contract. */
export const ExternalAgentToolsLive = Layer.effect(
  ExternalTools,
  Effect.gen(function* () {
    const mcp = yield* MCP;
    const browser = yield* browserSettings;
    const computer = yield* computerSettings;
    const config = yield* AppConfig;
    const servers = yield* mcpServers;
    const search = yield* webSearchEnabled;
    const memory = yield* Memory;
    const tasks = yield* TaskRepository;
    const { toolBytes, soulBytes, profileBytes, factsBytes } = yield* ChatSettings;

    return {
      instructions: [
        mcpInstructions,
        ...(browser.enabled ? [browserInstructions] : []),
        ...(computer.enabled ? [computerInstructions] : []),
      ].join(" "),
      snapshot: (scheduled, run) =>
        Effect.gen(function* () {
          const catalog = yield* Effect.gen(function* () {
            if (run.computer) {
              const target = yield* Effect.serviceOption(ComputerTarget);

              if (scheduled || !computer.enabled || Option.isNone(target))
                return yield* Effect.fail(
                  new AgentError({
                    reason: "tool-permission",
                    message:
                      "Computer observation requires configured access and the current standalone owner's target.",
                  }),
                );

              const context = yield* memory.snapshot({ soulBytes, profileBytes, factsBytes }).pipe(
                Effect.mapError(
                  () =>
                    new AgentError({
                      reason: "memory-storage",
                      message: "Cannot validate empty computer trial memory.",
                    }),
                ),
              );

              const jobs = yield* Effect.try({
                try: () => tasks.list(),
                catch: () =>
                  new AgentError({
                    reason: "tool-storage",
                    message: "Cannot validate computer trial schedules.",
                  }),
              });

              yield* validateComputerTrial({
                dataDirectory: config.dataDirectory,
                notesDirectory: config.notesDirectory,
                otherCapabilities: browser.enabled || servers.length > 0 || search,
                hasContext:
                  context.soul.length > 0 || context.profile.length > 0 || context.facts.length > 0,
                scheduledTasks: jobs.length,
              }).pipe(Effect.mapError(agentFailure));

              return yield* computerTools(computer, run.runId, toolBytes, target.value).pipe(
                Effect.mapError(agentFailure),
              );
            }

            const external = yield* mcp.snapshot(scheduled).pipe(Effect.mapError(agentFailure));

            const browserCatalog =
              scheduled || !browser.enabled
                ? []
                : yield* browserTools(browser, run.runId, toolBytes).pipe(
                    Effect.catch((error) =>
                      Console.error(`Browser unavailable: ${error.message}`).pipe(Effect.as([])),
                    ),
                  );

            return [...external, ...browserCatalog];
          });

          return catalog.map((tool) => ({
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
