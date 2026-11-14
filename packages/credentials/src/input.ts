import { Effect, Schema } from "effect";
import { Prompt } from "effect/cli";

import { ApiKey } from "#src/api-keys";

export const promptSecret = (
  message: string,
  invalidMessage = "Enter a nonempty API key without whitespace, up to 8192 characters.",
) =>
  Prompt.Password({
    message,
    validate: (input) =>
      Schema.decodeUnknownEffect(ApiKey)(input).pipe(
        Effect.as(input),
        Effect.mapError(() => invalidMessage),
      ),
  });
