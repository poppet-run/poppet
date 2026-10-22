import type { ModelRequest } from "@poppet/provider";
import type { ChatOptions } from "@poppet/provider/protocol";
import { Schema } from "effect";
import type { ChatCompletionAssistantMessageParam } from "openai/resources/chat/completions";

const Continuation = Schema.Struct({
  protocol: Schema.Literal("chat-completions"),
  reasoningContent: Schema.NullOr(Schema.String),
});

const Delta = Schema.Struct({
  reasoning_content: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const sessionHeaders = (request: ModelRequest) => ({
  "x-opencode-session": request.sessionId,
});

export const goOptions: ChatOptions = {
  headers: sessionHeaders,
  continuation: () => {
    let reasoning = "";

    return {
      restore: (data, message) => {
        const saved = Schema.decodeUnknownSync(Continuation, { onExcessProperty: "error" })(data);

        const restored: ChatCompletionAssistantMessageParam & { reasoning_content?: string } = {
          ...message,
        };

        if (saved.reasoningContent !== null) restored.reasoning_content = saved.reasoningContent;

        return restored;
      },
      append: (delta) => {
        const text = Schema.decodeUnknownSync(Delta)(delta).reasoning_content ?? "";
        reasoning += text;

        return text;
      },
      save: () => ({
        protocol: "chat-completions",
        reasoningContent: reasoning.length === 0 ? null : reasoning,
      }),
    };
  },
};
