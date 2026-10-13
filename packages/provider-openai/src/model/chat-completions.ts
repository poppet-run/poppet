import {
  Completion,
  ProviderError,
  invalidRequest,
  interrupted,
  type ModelDescription,
  type ModelEvent,
  type ModelOperations,
  type ModelRequest,
  type Output,
  type Tool,
} from "@poppet/provider";
import { Effect, Schema } from "effect";
import type OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";

import { inferenceFailure } from "#src/model/errors";
import { modelStream } from "#src/model/scoped-stream";

const Chunk = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      index: Schema.Natural,
      finish_reason: Schema.NullOr(Schema.String),
      delta: Schema.Struct({
        role: Schema.optionalKey(Schema.Literal("assistant")),
        content: Schema.optionalKey(Schema.NullOr(Schema.String)),
        reasoning_content: Schema.optionalKey(Schema.NullOr(Schema.String)),
        tool_calls: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              index: Schema.Natural,
              id: Schema.optionalKey(Schema.String),
              type: Schema.optionalKey(Schema.Literal("function")),
              function: Schema.optionalKey(
                Schema.Struct({
                  name: Schema.optionalKey(Schema.String),
                  arguments: Schema.optionalKey(Schema.String),
                }),
              ),
            }),
          ),
        ),
      }),
    }),
  ),
  usage: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ prompt_tokens: Schema.Natural, completion_tokens: Schema.Natural }),
    ),
  ),
});

const Continuation = Schema.Struct({
  protocol: Schema.Literal("chat-completions"),
  reasoningContent: Schema.NullOr(Schema.String),
});

interface ReasoningMessage extends ChatCompletionAssistantMessageParam {
  reasoning_content?: string;
}

const wireName = (tool: Tool) =>
  tool.namespace === null ? tool.name : `${tool.namespace}__${tool.name}`;

const toolNames = (description: ModelDescription, request: ModelRequest) => {
  const names = new Map<string, Tool>();

  for (const tool of request.tools) {
    const name = wireName(tool);

    if (name.length > 64 || names.has(name))
      throw invalidRequest(
        description.provider,
        "Tool names are too long or collide in Chat Completions.",
      );
    names.set(name, tool);
  }

  return names;
};

const chatMessages = (request: ModelRequest): ChatCompletionMessageParam[] => {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: request.instructions },
  ];

  for (const message of request.messages) {
    if (message.role === "user") messages.push({ role: "user", content: message.text });
    else if (message.role === "tool")
      messages.push({ role: "tool", tool_call_id: message.callId, content: message.output });
    else {
      const saved =
        message.continuation === null
          ? null
          : Schema.decodeUnknownSync(Continuation, { onExcessProperty: "error" })(
              message.continuation.data,
            );

      const toolCalls = message.output.flatMap((part) =>
        part.type === "tool-call"
          ? [
              {
                id: part.callId,
                type: "function" as const,
                function: {
                  name: wireName({ ...part, description: "", parameters: {} }),
                  arguments: part.arguments,
                },
              },
            ]
          : [],
      );

      const assistant: ReasoningMessage = {
        role: "assistant",
        content: message.output
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join(""),
        tool_calls: toolCalls,
      };

      if (saved?.reasoningContent !== null && saved?.reasoningContent !== undefined)
        assistant.reasoning_content = saved.reasoningContent;
      messages.push(assistant);
    }
  }

  return messages;
};

export const chatCompletionsModel = (
  description: ModelDescription,
  client: Effect.Effect<OpenAI, ProviderError>,
): ModelOperations => ({
  description,
  stream: (request) =>
    modelStream(description, request, (decoded, signal) =>
      Effect.gen(function* () {
        const names = yield* Effect.try({
          try: () => toolNames(description, decoded),
          catch: (cause) =>
            cause instanceof ProviderError
              ? cause
              : invalidRequest(description.provider, "The tool definitions are invalid."),
        });

        const messages = yield* Effect.try({
          try: () => chatMessages(decoded),
          catch: () =>
            invalidRequest(description.provider, "The Chat Completions continuation is invalid."),
        });

        const sdk = yield* client;

        const parameters: ChatCompletionCreateParamsStreaming = {
          model: description.id,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          tools: [...names.entries()].map(([name, tool]) => ({
            type: "function",
            function: { name, description: tool.description, parameters: { ...tool.parameters } },
          })),
          tool_choice: decoded.settings.toolChoice ?? "auto",
        };

        if (decoded.settings.temperature !== undefined)
          parameters.temperature = decoded.settings.temperature;

        if (decoded.settings.maxOutputTokens !== undefined)
          parameters.max_tokens = decoded.settings.maxOutputTokens;

        const stream = yield* Effect.tryPromise({
          try: () =>
            sdk.chat.completions.create(parameters, {
              signal,
              headers: { "x-opencode-session": decoded.sessionId },
            }),
          catch: (cause) => inferenceFailure(description.provider, cause),
        });

        const events = async function* (): AsyncGenerator<ModelEvent> {
          let text = "";
          let reasoning = "";
          let finish: string | null = null;
          let usage: Completion["usage"] = null;
          const calls = new Map<number, { id: string; name: string; arguments: string }>();

          try {
            for await (const raw of stream) {
              const chunk = Schema.decodeUnknownSync(Chunk)(raw);

              if (chunk.usage)
                usage = {
                  inputTokens: chunk.usage.prompt_tokens,
                  outputTokens: chunk.usage.completion_tokens,
                };

              if (chunk.choices.length === 0) continue;

              const choice = chunk.choices[0];

              if (!choice || chunk.choices.length !== 1 || choice.index !== 0 || finish !== null)
                throw interrupted(
                  description.provider,
                  "The model returned an invalid choice sequence.",
                );

              if (choice.delta.content) {
                text += choice.delta.content;
                yield { type: "text-delta", text: choice.delta.content };
              }

              if (choice.delta.reasoning_content) reasoning += choice.delta.reasoning_content;

              for (const part of choice.delta.tool_calls ?? []) {
                let call = calls.get(part.index);

                if (!call) {
                  call = { id: "", name: "", arguments: "" };
                  calls.set(part.index, call);
                }

                call.id += part.id ?? "";
                call.name += part.function?.name ?? "";
                call.arguments += part.function?.arguments ?? "";
              }

              if (choice.finish_reason !== null) finish = choice.finish_reason;
            }

            if (finish !== "stop" && finish !== "tool_calls")
              throw interrupted(
                description.provider,
                "The stream ended without successful completion.",
              );

            if ((finish === "tool_calls") !== calls.size > 0)
              throw interrupted(
                description.provider,
                "The completion reason does not match its tool calls.",
              );

            const output: Output[] = text.length === 0 ? [] : [{ type: "text", text }];
            const ids = new Set<string>();

            for (const [position, [index, call]] of [...calls.entries()]
              .toSorted(([left], [right]) => left - right)
              .entries()) {
              if (index !== position)
                throw interrupted(description.provider, "The stream omitted a tool call.");

              const tool = names.get(call.name);

              if (!tool || !call.id || ids.has(call.id))
                throw interrupted(description.provider, "The model returned an invalid tool call.");
              Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(call.arguments);
              ids.add(call.id);
              output.push({
                type: "tool-call",
                callId: call.id,
                name: tool.name,
                namespace: tool.namespace,
                arguments: call.arguments,
              });
            }

            const response = Schema.decodeUnknownSync(Completion)({
              output,
              continuation: {
                version: 1,
                provider: description.provider,
                model: description.id,
                data: {
                  protocol: "chat-completions",
                  reasoningContent: reasoning.length === 0 ? null : reasoning,
                },
              },
              finishReason: calls.size > 0 ? "tool-calls" : "stop",
              usage,
            });

            yield { type: "completed", response };
          } catch (cause) {
            if (cause instanceof Schema.SchemaError || cause instanceof SyntaxError)
              throw interrupted(
                description.provider,
                "The model returned a malformed Chat Completions stream.",
              );
            throw cause;
          } finally {
            stream.controller.abort();
          }
        };

        return events();
      }),
    ),
});
