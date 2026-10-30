import { ChatSettings } from "@poppet/agent";
import {
  AppConfig,
  ConfigSource,
  taskCatchUpMinutes,
  webSearchEnabled,
  webSearchProvider,
  gatewayPackages,
} from "@poppet/config";
import { mcpServers } from "@poppet/mcp";
import { Effect } from "effect";
import { Command } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { jsonFlag } from "#src/commands/flags";
import { printResult, tree } from "#src/output";

const showConfig = (json: boolean) =>
  Effect.gen(function* () {
    const { logReasoning, logTimings, outputTokens, runDeadlineSeconds, maxConcurrentRequests } =
      yield* ChatSettings;

    yield* printResult(
      json,
      {
        ...(yield* AppConfig),
        webSearch: yield* webSearchEnabled,
        webSearchProvider: yield* webSearchProvider,
        mcpServers: yield* mcpServers,
        gatewayPackages: yield* gatewayPackages,
        chat: {
          logReasoning,
          logTimings,
          outputTokens,
          runDeadlineSeconds,
          maxConcurrentRequests,
        },
        tasks: { catchUpMinutes: yield* taskCatchUpMinutes },
        ...(yield* ConfigSource),
      },
      tree,
    );
  });

export const configCommand = (context: CLIContext) => {
  const { runtime } = context;

  return Command.make("config", { json: jsonFlag }, ({ json }) =>
    showConfig(json).pipe(Effect.provide([runtime.config, runtime.chatSettings])),
  ).pipe(Command.withDescription("Show validated configuration"));
};
