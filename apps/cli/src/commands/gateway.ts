import { Console, Effect } from "effect";
import { Argument, Command } from "effect/cli";

import { setupChannel, stoppedMessagingStatus } from "#src/channels";
import type { CLIContext } from "#src/commands/context";

export const gatewayCommand = (context: CLIContext) => {
  const { runtime, channels: registeredChannels, startWorker, throughWorker } = context;

  return Command.make("gateway").pipe(
    Command.withDescription("Set up and run messaging channels"),
    Command.withSubcommands([
      ...registeredChannels.map((entry) =>
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
      Command.make("work", {}, () => startWorker("gateway")).pipe(
        Command.withDescription("Run messaging only in the foreground"),
      ),
      Command.make("status", {}, () =>
        throughWorker(
          { kind: "gateway" },
          stoppedMessagingStatus(registeredChannels).pipe(
            Effect.flatMap((status) => Console.log(JSON.stringify(status, null, 2))),
            Effect.provide(runtime.messagingStatus),
          ),
        ),
      ).pipe(Command.withDescription("Show messaging connection, queue, and delivery status")),
    ]),
  );
};
