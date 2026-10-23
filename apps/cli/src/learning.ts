import { LearningReviews, ReviewState } from "@poppet/memory";
import { Effect, Schema } from "effect";

/** Background-review inspection shared by direct CLI execution and worker routing. */
export const LearningCommand = Schema.Struct({
  action: Schema.Literal("reviews"),
  state: Schema.optionalKey(ReviewState),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
});

export type LearningCommand = typeof LearningCommand.Type;

export const manageLearning = (command: LearningCommand) =>
  LearningReviews.use((reviews) =>
    reviews.list(
      command.state === undefined
        ? { limit: command.limit }
        : { state: command.state, limit: command.limit },
    ),
  ).pipe(Effect.map((list) => JSON.stringify(list, null, 2)));
