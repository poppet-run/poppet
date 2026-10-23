import { ReviewState } from "@poppet/memory";
import { Console, Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { manageLearning, type LearningCommand } from "#src/learning";

export const learningCommand = (context: CLIContext) => {
  const { runtime, throughWorker } = context;

  const runLearning = (command: LearningCommand) =>
    throughWorker(
      { kind: "learning", command },
      manageLearning(command).pipe(
        Effect.provide(runtime.learningReviews),
        Effect.flatMap(Console.log),
      ),
    );

  return Command.make("learning").pipe(
    Command.withDescription("Inspect what Poppet learned in the background"),
    Command.withSubcommands([
      Command.make(
        "reviews",
        {
          state: Flag.Literals("state", ReviewState.literals).pipe(
            Flag.optional,
            Flag.withDescription("Only reviews in this state"),
          ),
          limit: Flag.Int("limit").pipe(
            Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
            Flag.withDefault(20),
            Flag.withDescription("Most recent reviews to show"),
          ),
        },
        ({ state, limit }) =>
          runLearning(
            Option.isSome(state)
              ? { action: "reviews", state: state.value, limit }
              : { action: "reviews", limit },
          ),
      ).pipe(Command.withDescription("List background reviews and the changes they made")),
    ]),
  );
};
