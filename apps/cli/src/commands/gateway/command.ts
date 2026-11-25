import { Effect } from "effect";
import { Argument, Command } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { setupGateway } from "#src/commands/gateway/gateways";

export const gatewayCommand = (context: CLIContext) => {
  const { runtime, gateways: registeredGateways } = context;

  return Command.make("gateway").pipe(
    Command.withDescription("Set up messaging gateways"),
    Command.withSubcommands(
      registeredGateways.map((entry) =>
        Command.make(
          entry.id,
          {
            args: Argument.String("args").pipe(Argument.variadic()),
          },
          ({ args }) =>
            setupGateway(registeredGateways, [entry.id, ...args]).pipe(
              Effect.provide(runtime.config),
            ),
        ).pipe(Command.withDescription(`${entry.name}: gateway ${entry.id} ${entry.setupHelp}`)),
      ),
    ),
  );
};
