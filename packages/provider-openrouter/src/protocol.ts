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

const present = (value: ReasoningDetail[string] | undefined) =>
  value !== null && value !== undefined && value !== "";

const mergeDetail = (details: Array<ReasoningDetail>, fragment: ReasoningDetail) => {
  const fields = ["index", "id", "format"] as const;

  // A fragment without an index or ID cannot be tied to an earlier block, and a block's
  // data is never replaced, so either case starts a separate block.
  const candidate = (detail: ReasoningDetail) =>
    detail.type === fragment.type && !(present(detail.data) && present(fragment.data));

  let index = -1;

  if (present(fragment.index) || present(fragment.id)) {
    index = details.findIndex(
      (detail) =>
        candidate(detail) &&
        fields.every((field) => (detail[field] ?? null) === (fragment[field] ?? null)),
    );

    const matches = details.flatMap((detail, position) =>
      candidate(detail) &&
      ((present(fragment.index) && fragment.index === detail.index) ||
        (present(fragment.id) && fragment.id === detail.id)) &&
      fields.every(
        (field) =>
          !present(detail[field]) || !present(fragment[field]) || detail[field] === fragment[field],
      )
        ? [position]
        : [],
    );

    if (index < 0 && matches.length === 1 && matches[0] !== undefined) {
      index = matches[0];
    }
  }

  const previous = details[index];

  if (previous === undefined) {
    details.push(fragment);

    return;
  }

  details[index] = {
    ...previous,
    ...Object.fromEntries(Object.entries(fragment).filter(([, value]) => present(value))),
    ...(present(fragment.text) && { text: (previous.text ?? "") + fragment.text }),
    ...(present(fragment.summary) && { summary: (previous.summary ?? "") + fragment.summary }),
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
  ) {
    return inferenceFailure("openrouter", cause);
  }

  const numeric = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 })))(
      cause.code,
    ),
  );

  const code = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.String)(cause.code));

  const status = Number.isInteger(cause.status) ? Number(cause.status) : numeric;

  return remoteFailure("openrouter", status, code, cause.requestID, routerReason);
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
        if (key === "role") {
          return value === "assistant" || value === null;
        }

        if (key === "content") {
          return value === null || value === "";
        }

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
    const details: Array<ReasoningDetail> = [];

    return {
      restore: (data, message) => {
        const saved = Schema.decodeUnknownSync(Continuation, { onExcessProperty: "error" })(data);

        const restored: ChatCompletionAssistantMessageParam & {
          reasoning?: string;
          reasoning_details?: ReadonlyArray<typeof ReasoningDetail.Type>;
        } = { ...message };

        if (saved.reasoningDetails.length > 0) {
          restored.reasoning_details = saved.reasoningDetails;
        } else if (saved.reasoningContent !== null) {
          restored.reasoning = saved.reasoningContent;
        }

        return restored;
      },
      append: (delta) => {
        const value = Schema.decodeUnknownSync(Delta)(delta);
        reasoning += value.reasoning ?? value.reasoning_content ?? "";

        for (const detail of value.reasoning_details ?? []) {
          mergeDetail(details, detail);
        }

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
