import { limit } from "@poppet/io";
import { ModelEvent, outputText } from "@poppet/provider";
import type { Completion, ModelOperations, ModelRequest, ProviderError } from "@poppet/provider";
import type { Run } from "@poppet/store";
import { Effect, Schema, Stream } from "effect";

import { byteSize } from "#src/context";
import { AgentError } from "#src/errors";

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

const validateCompletion = (
  response: Completion | null,
  run: Pick<Run, "provider" | "model">,
  streamed: string,
  limits: { readonly textBytes: number; readonly completionBytes: number },
) => {
  if (response === null) {
    throw protocolFailure();
  }

  const hasCalls = response.output.some((part) => part.type === "tool-call");

  if (hasCalls !== (response.finishReason === "tool-calls")) {
    throw protocolFailure();
  }

  if (
    response.continuation.provider !== run.provider ||
    response.continuation.model !== run.model
  ) {
    throw protocolFailure();
  }

  const finalText = outputText(response.output);

  if (!finalText.startsWith(streamed)) {
    throw protocolFailure();
  }

  if (
    byteSize(finalText) > limits.textBytes ||
    byteSize(JSON.stringify(response)) > limits.completionBytes
  ) {
    throw outputLimit();
  }

  return { response, remaining: finalText.slice(streamed.length) };
};

export const streamReply = (
  model: ModelOperations,
  request: ModelRequest,
  run: Pick<Run, "provider" | "model">,
): Stream.Stream<ModelEvent, AgentError | ProviderError> =>
  Stream.unwrap(
    Effect.all({
      textBytes: limit("replyTextBytes"),
      completionBytes: limit("completionBytes"),
    }).pipe(Effect.map((limits) => replyStream(model, request, run, limits))),
  );

const replyStream = (
  model: ModelOperations,
  request: ModelRequest,
  run: Pick<Run, "provider" | "model">,
  limits: { readonly textBytes: number; readonly completionBytes: number },
): Stream.Stream<ModelEvent, AgentError | ProviderError> =>
  Stream.suspend(() => {
    let completed: Completion | null = null;
    let streamed = "";
    let streamedBytes = 0;

    const deltas = model.stream(request).pipe(
      Stream.mapEffect((event) =>
        Effect.gen(function* () {
          const decoded = yield* Schema.decodeUnknownEffect(ModelEvent, {
            onExcessProperty: "error",
          })(event).pipe(Effect.mapError(protocolFailure));

          if (completed !== null) {
            return yield* Effect.fail(protocolFailure());
          }

          if (decoded.type === "completed") {
            completed = decoded.response;

            return null;
          }

          if (decoded.type === "reasoning-delta") {
            return decoded;
          }

          streamedBytes += byteSize(decoded.text);

          if (streamedBytes > limits.textBytes) {
            return yield* Effect.fail(outputLimit());
          }

          streamed += decoded.text;

          return decoded;
        }),
      ),
      Stream.filter((event) => event !== null),
    );

    const finish = Stream.fromEffect(
      Effect.try({
        try: () => validateCompletion(completed, run, streamed, limits),
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
