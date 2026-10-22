import { Store } from "@poppet/store";
import { Console, Effect } from "effect";
import { Command } from "effect/cli";

import type { CLIContext } from "#src/commands/context";

export const storeCommand = (context: CLIContext) => {
  const { runtime, throughWorker } = context;

  return Command.make("store").pipe(
    Command.withDescription("Inspect the conversation store"),
    Command.withSubcommands([
      Command.make("status", {}, () =>
        throughWorker(
          { kind: "store" },
          Store.use((store) =>
            store.status.pipe(
              Effect.flatMap((status) => Console.log(JSON.stringify(status, null, 2))),
            ),
          ).pipe(Effect.provide(runtime.store)),
        ),
      ).pipe(Command.withDescription("Open/migrate the conversation store and show counts")),
    ]),
  );
};
