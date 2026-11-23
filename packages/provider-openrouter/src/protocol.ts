import type { ProviderError } from "@poppet/provider";
import { inferenceFailure, remoteFailure } from "@poppet/provider/protocol";
import type { ChatOptions, RemoteReason } from "@poppet/provider/protocol";
import { Option, Schema } from "effect";
import { APIConnectionError, APIError, APIUserAbortError } from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";

const ReasoningDetail = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.Literals(["reasoning.text", "reasoning.summary", "reasoning.encrypted"]),
    index: Schema.optionalKey(Schema.NullOr(Schema.Natural)),
    id: Schema.optionalKey(Schema.NullOr(Schema.String)),
    format: Schema.optionalKey(Schema.NullOr(Schema.String)),
    text: Schema.optionalKey(Schema.NullOr(Schema.String)),
    summary: Schema.optionalKey(Schema.NullOr(Schema.String)),
    data: Schema.optionalKey(Schema.NullOr(Schema.String)),
    signature: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

type ReasoningDetail = typeof ReasoningDetail.Type;

const mergeDetail = (details: ReasoningDetail[], fragment: ReasoningDetail) => {
  const fields = ["index", "id", "format"] as const;

  let index = details.findIndex(
    (detail) =>
      detail.type === fragment.type &&
      fields.every((field) => (detail[field] ?? null) === (fragment[field] ?? null)),
  );

  if (
    index < 0 &&
    ((fragment.index !== null && fragment.index !== undefined) ||
      (fragment.id !== null && fragment.id !== undefined))
  ) {
    const matches = details.flatMap((detail, position) =>
      detail.type === fragment.type &&
      ((fragment.index !== null &&
        fragment.index !== undefined &&
        fragment.index === detail.index) ||
        (fragment.id !== null && fragment.id !== undefined && fragment.id === detail.id)) &&
      fields.every(
        (field) =>
          detail[field] === null ||
          detail[field] === undefined ||
          fragment[field] === null ||
          fragment[field] === undefined ||
          detail[field] === fragment[field],
      )
        ? [position]
        : [],
    );

    if (matches.length === 1) index = matches[0]!;
  }

  const previous = details[index];

  if (previous === undefined) {
    details.push(fragment);

    return;
  }

  const present = Object.fromEntries(
    Object.entries(fragment).filter(([, value]) => value !== null),
  );

  details[index] = {
    ...previous,
    ...present,
    ...(fragment.text !== null &&
      fragment.text !== undefined && { text: (previous.text ?? "") + fragment.text }),
    ...(fragment.summary !== null &&
      fragment.summary !== undefined && { summary: (previous.summary ?? "") + fragment.summary }),
  };
};

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

const routerReason: RemoteReason = (status, code) =>
  status === 402
    ? "quota"
    : ["server_error", "provider_error"].includes(code ?? "")
      ? "temporary"
      : undefined;

export const routerFailure = (cause: unknown): ProviderError => {
  if (
    !(cause instanceof APIError) ||
    cause instanceof APIConnectionError ||
    cause instanceof APIUserAbortError
  )
    return inferenceFailure("openrouter", cause);

  const numeric = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 })))(
      cause.code,
    ),
  );

  const code = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.String)(cause.code));

  return remoteFailure("openrouter", cause.status ?? numeric, code, cause.requestID, routerReason);
};

export const routerOptions: ChatOptions = {
  failure: routerFailure,
  isAccountingFrame: (chunk, finishReason) => {
    const choice = chunk.choices[0];

    return (
      chunk.usage !== null &&
      chunk.usage !== undefined &&
      choice !== undefined &&
      choice.finish_reason === finishReason &&
      Object.entries(choice.delta).every(([key, value]) => {
        if (key === "role") return value === "assistant" || value === null;

        if (key === "content") return value === null || value === "";

        return value === null;
      })
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
    const details: ReasoningDetail[] = [];

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

        for (const detail of value.reasoning_details ?? []) mergeDetail(details, detail);

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
