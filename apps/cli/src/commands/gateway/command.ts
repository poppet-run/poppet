import { Effect } from "effect";
import { Argument, Command } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { setupChannel } from "#src/commands/gateway/channels";

export const gatewayCommand = (context: CLIContext) => {
  const { runtime, channels: registeredChannels } = context;

  return Command.make("gateway").pipe(
    Command.withDescription("Set up messaging channels"),
    Command.withSubcommands(
      registeredChannels.map((entry) =>
        Command.make(
          entry.id,
          {
            args: Argument.String("args").pipe(Argument.variadic()),
          },
          ({ args }) =>
            setupChannel(registeredChannels, [entry.id, ...args]).pipe(
              Effect.provide(runtime.config),
            ),
        ).pipe(Command.withDescription(`${entry.name}: gateway ${entry.id} ${entry.setupHelp}`)),
      ),
    ),
  );
};
