import { ProviderError } from "@poppet/provider";
import { inferenceFailure, remoteFailure, type ChatOptions } from "@poppet/provider-protocol";
import { Option, Schema } from "effect";
import { APIError } from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";

// Preserve each reasoning delta, including provider metadata, in its original order.
const ReasoningDetail = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.Literals(["reasoning.text", "reasoning.summary", "reasoning.encrypted"]),
    index: Schema.optionalKey(Schema.Natural),
    id: Schema.optionalKey(Schema.NullOr(Schema.String)),
    format: Schema.optionalKey(Schema.String),
    text: Schema.optionalKey(Schema.NullOr(Schema.String)),
    summary: Schema.optionalKey(Schema.String),
    data: Schema.optionalKey(Schema.String),
    signature: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

const Continuation = Schema.Struct({
  protocol: Schema.Literal("chat-completions"),
  reasoningContent: Schema.NullOr(Schema.String),
  reasoningDetails: Schema.Array(ReasoningDetail),
});

const Delta = Schema.Struct({
  reasoning: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reasoning_content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reasoning_details: Schema.optionalKey(Schema.NullOr(Schema.Array(ReasoningDetail))),
});

export const routerFailure = (cause: unknown): ProviderError => {
  if (!(cause instanceof APIError)) return inferenceFailure("openrouter", cause);

  // Stream errors may encode an HTTP status in their numeric code.
  const numeric = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 })))(
      cause.code,
    ),
  );

  const code = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.String)(cause.code));
  const status = cause.status ?? numeric;
  const error = remoteFailure("openrouter", status, code, cause.requestID);

  const reason =
    status === 402
      ? "quota"
      : ["server_error", "provider_error"].includes(code ?? "")
        ? "temporary"
        : error.reason;

  return new ProviderError({
    ...error,
    reason,
    message: `The openrouter request failed (${reason}). No automatic retry was attempted.`,
  });
};

export const routerOptions: ChatOptions = {
  failure: routerFailure,
  isAccountingFrame: (chunk, finishReason) => {
    const choice = chunk.choices[0];

    // OpenRouter's final usage frame repeats the terminal choice with an empty
    // delta. Keep this exception local to OpenRouter and require matching finish.
    return (
      chunk.usage != null &&
      choice !== undefined &&
      choice.finish_reason === finishReason &&
      Object.entries(choice.delta).every(([key, value]) =>
        key === "role"
          ? value === "assistant"
          : key === "content" && (value === null || value === ""),
      )
    );
  },
  prepareRequest: (parameters, request) => {
    const routed: ChatCompletionCreateParamsStreaming & {
      provider: { require_parameters: true; allow_fallbacks: false };
      session_id: string;
    } = {
      ...parameters,
      provider: { require_parameters: true, allow_fallbacks: false },
      session_id: request.sessionId,
    };

    return routed;
  },
  continuation: () => {
    let reasoning = "";
    const details: Array<typeof ReasoningDetail.Type> = [];

    return {
      restore: (data, message) => {
        const saved = Schema.decodeUnknownSync(Continuation, { onExcessProperty: "error" })(data);

        const restored: ChatCompletionAssistantMessageParam & {
          reasoning?: string;
          reasoning_details?: ReadonlyArray<typeof ReasoningDetail.Type>;
        } = { ...message };

        if (saved.reasoningDetails.length > 0) restored.reasoning_details = saved.reasoningDetails;
        else if (saved.reasoningContent !== null) restored.reasoning = saved.reasoningContent;

        return restored;
      },
      append: (delta) => {
        const value = Schema.decodeUnknownSync(Delta)(delta);
        reasoning += value.reasoning ?? value.reasoning_content ?? "";
        details.push(...(value.reasoning_details ?? []));

        // Structured details can duplicate the plain field in the same frame.
        const readable = (value.reasoning_details ?? [])
          .flatMap((detail) =>
            detail.type === "reasoning.encrypted" ? [] : [detail.text ?? detail.summary ?? ""],
          )
          .join("");

        return readable || value.reasoning || value.reasoning_content || "";
      },
      save: () => ({
        protocol: "chat-completions",
        reasoningContent: reasoning.length === 0 ? null : reasoning,
        reasoningDetails: details,
      }),
    };
  },
};
