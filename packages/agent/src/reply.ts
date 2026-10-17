import {
  ModelEvent,
  type Completion,
  type ModelOperations,
  type ModelRequest,
  type ProviderError,
} from "@poppet/provider";
import type { Run } from "@poppet/store";
import { Effect, Schema, Stream } from "effect";

import { byteSize } from "#src/context";
import { AgentError } from "#src/errors";

export const maxTextBytes = 131072;

const maxCompletionBytes = 1048576;

const protocolFailure = () =>
  new AgentError({
    reason: "protocol",
    message:
      "The model returned an invalid completion sequence. Partial output was not saved as an answer.",
  });

const outputLimit = () =>
  new AgentError({
    reason: "output-limit",
    message: "The response exceeded the output size limit.",
  });

// The final response must agree with the selected model and text already shown to the consumer.
const validateCompletion = (
  response: Completion | null,
  run: Pick<Run, "provider" | "model">,
  streamed: string,
) => {
  if (response === null) throw protocolFailure();

  const hasCalls = response.output.some((part) => part.type === "tool-call");

  if (hasCalls !== (response.finishReason === "tool-calls")) throw protocolFailure();

  if (response.continuation.provider !== run.provider || response.continuation.model !== run.model)
    throw protocolFailure();

  const finalText = response.output
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");

  if (!finalText.startsWith(streamed)) throw protocolFailure();

  if (byteSize(finalText) > maxTextBytes || byteSize(JSON.stringify(response)) > maxCompletionBytes)
    throw outputLimit();

  return { response, remaining: finalText.slice(streamed.length) };
};

/** Forwards text immediately, but validates and emits completion only after the source ends cleanly. */
export const streamReply = (
  model: ModelOperations,
  request: ModelRequest,
  run: Pick<Run, "provider" | "model">,
): Stream.Stream<ModelEvent, AgentError | ProviderError> =>
  Stream.suspend(() => {
    let completed: Completion | null = null;
    let streamed = "";
    let streamedBytes = 0;
    let reasoningBytes = 0;

    const deltas = model.stream(request).pipe(
      Stream.mapEffect((event) =>
        Effect.gen(function* () {
          const decoded = yield* Schema.decodeUnknownEffect(ModelEvent, {
            onExcessProperty: "error",
          })(event).pipe(Effect.mapError(protocolFailure));

          if (completed !== null) return yield* Effect.fail(protocolFailure());

          if (decoded.type === "completed") {
            completed = decoded.response;

            return null;
          }

          if (decoded.type === "reasoning-delta") {
            reasoningBytes += byteSize(decoded.text);

            if (reasoningBytes > maxTextBytes) return yield* Effect.fail(outputLimit());

            return decoded;
          }

          streamedBytes += byteSize(decoded.text);

          if (streamedBytes > maxTextBytes) return yield* Effect.fail(outputLimit());
          streamed += decoded.text;

          return decoded;
        }),
      ),
      Stream.filter((event) => event !== null),
    );

    const finish = Stream.fromEffect(
      Effect.try({
        try: () => validateCompletion(completed, run, streamed),
        catch: (cause) => (cause instanceof AgentError ? cause : protocolFailure()),
      }),
    ).pipe(
      Stream.flatMap(({ response, remaining }) => {
        const terminal = Stream.make({ type: "completed" as const, response });

        return remaining.length === 0
          ? terminal
          : Stream.concat(Stream.make({ type: "text-delta" as const, text: remaining }), terminal);
      }),
    );

    return Stream.concat(deltas, finish);
  });
