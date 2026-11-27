import { timeout } from "@poppet/io";
import { outputText } from "@poppet/provider";
import type { ModelOperations } from "@poppet/provider";
import type { Run } from "@poppet/store";
import { Effect, Option, Schema, Stream } from "effect";

import { AgentError } from "#src/errors";
import { streamReply } from "#src/reply";
import { BoundedText } from "#src/tools/tool-schema";

export const BashReview = Schema.Struct({
  decision: Schema.Literals(["allow", "needs_approval", "deny"]),
  reason: BoundedText(1024),
});

export const MCPReview = Schema.Union([
  Schema.Struct({
    decision: Schema.Literals(["allow", "deny"]),
    reason: BashReview.fields.reason,
  }),
  Schema.Struct({
    decision: Schema.Literal("needs_approval"),
    reason: BashReview.fields.reason,
    target: BoundedText(1024),
    effects: BoundedText(1024),
  }),
]);

export const reviewAction = <A>(
  model: ModelOperations,
  run: Run,
  instructions: string,
  input: string,
  response: Schema.Decoder<A>,
  failureReason: "command-review" | "mcp-review",
) =>
  Effect.gen(function* () {
    const label = failureReason === "command-review" ? "Command review" : "MCP review";
    let bytes = 0;

    const last = yield* streamReply(
      model,
      {
        sessionId: run.sessionId,
        instructions,
        messages: [
          {
            role: "user",
            text: input,
          },
        ],
        tools: [],
        settings: model.description.capabilities.generationSettings.includes("maxOutputTokens")
          ? {
              toolChoice: "none",
              maxOutputTokens: Math.min(512, model.description.capabilities.maxOutputTokens ?? 512),
            }
          : { toolChoice: "none" },
      },
      run,
    ).pipe(
      Stream.tap((event) =>
        Effect.gen(function* () {
          if (event.type !== "text-delta") {
            return;
          }

          bytes += Buffer.byteLength(event.text);

          if (bytes > 4096) {
            return yield* Effect.fail(
              new AgentError({
                reason: failureReason,
                message: `${label} exceeded its output limit. Nothing was executed.`,
              }),
            );
          }
        }),
      ),
      Stream.runLast,
      Effect.timeout(yield* timeout("actionReviewSeconds")),
      Effect.mapError(
        () =>
          new AgentError({
            reason: failureReason,
            message: `${label} failed or timed out. Nothing was executed.`,
          }),
      ),
    );

    if (
      Option.isNone(last) ||
      last.value.type !== "completed" ||
      last.value.response.finishReason !== "stop" ||
      last.value.response.output.some((part) => part.type !== "text")
    ) {
      return yield* Effect.fail(
        new AgentError({
          reason: failureReason,
          message: `${label} did not return a decision. Nothing was executed.`,
        }),
      );
    }

    const text = outputText(last.value.response.output);

    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(response), {
      onExcessProperty: "error",
    })(text).pipe(
      Effect.mapError(
        () =>
          new AgentError({
            reason: failureReason,
            message: `${label} returned an invalid decision. Nothing was executed.`,
          }),
      ),
    );
  });
