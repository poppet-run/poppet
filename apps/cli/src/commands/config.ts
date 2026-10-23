import { ChatSettings } from "@poppet/agent";
import {
  AppConfig,
  ConfigSource,
  taskCatchUpMinutes,
  webSearchEnabled,
  webSearchProvider,
  browserSettings,
  gatewayPackages,
} from "@poppet/config";
import { mcpServers } from "@poppet/mcp";
import { Console, Effect } from "effect";
import { Command } from "effect/cli";

import type { CLIContext } from "#src/commands/context";

export const configCommand = (context: CLIContext) => {
  const { runtime } = context;

  const showConfig = Effect.gen(function* () {
    yield* Console.log(
      JSON.stringify(
        {
          ...(yield* AppConfig),
          webSearch: yield* webSearchEnabled,
          webSearchProvider: yield* webSearchProvider,
          browser: yield* browserSettings,
          mcpServers: yield* mcpServers,
          gatewayPackages: yield* gatewayPackages,
          chat: yield* ChatSettings,
          tasks: { catchUpMinutes: yield* taskCatchUpMinutes },
          ...(yield* ConfigSource),
        },
        null,
        2,
      ),
    );
  });

  return Command.make("config", {}, () =>
    showConfig.pipe(Effect.provide([runtime.config, runtime.chatSettings])),
  ).pipe(Command.withDescription("Show validated configuration"));
};
