import { Provider, verifyModel } from "@poppet/provider";
import { Console, Effect } from "effect";
import { Command } from "effect/cli";

import type { CLIContext } from "#src/commands/context";

export const showModels = Effect.gen(function* () {
  const provider = yield* Provider;
  yield* Console.log(JSON.stringify(yield* provider.models, null, 2));
});

export const providerCommand = (context: CLIContext) => {
  const { runtime } = context;

  return Command.make("provider").pipe(
    Command.withDescription("Inspect and verify the configured provider"),
    Command.withSubcommands([
      Command.make("models", {}, () => showModels.pipe(Effect.provide(runtime.provider))).pipe(
        Command.withDescription("List supported models"),
      ),
      Command.make("verify", {}, () =>
        Effect.scoped(
          Effect.gen(function* () {
            const model = yield* runtime.resolveModel;
            yield* verifyModel(model);
            yield* Console.log(
              `Provider verification passed with ${model.description.provider}/${model.description.id}. Completed inference and one local tool round trip.`,
            );
          }),
        ).pipe(Effect.provide(runtime.config)),
      ).pipe(Command.withDescription("Verify the configured model with a local tool")),
    ]),
  );
};
