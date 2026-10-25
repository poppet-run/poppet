import { Effect, Schema } from "effect";
import type OpenAI from "openai";
import type {
  FunctionTool,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseReasoningItem,
  ResponseCreateParamsStreaming,
  Tool,
} from "openai/resources/responses/responses";

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
} from "#src/index";
import { inferenceFailure, remoteFailure, type InferenceOptions } from "#src/protocol/errors";
import { inIndexOrder, modelStream } from "#src/protocol/scoped-stream";

const Content = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("output_text"),
    text: Schema.String,
    annotations: Schema.Array(Schema.JsonObject),
  }),
  Schema.Struct({ type: Schema.Literal("refusal"), refusal: Schema.String }),
]);

const Item = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("message"),
    id: Schema.NonEmptyString,
    role: Schema.Literal("assistant"),
    status: Schema.Literal("completed"),
    content: Schema.Array(Content),
  }),
  Schema.Struct({
    type: Schema.Literal("reasoning"),
    id: Schema.NonEmptyString,
    summary: Schema.Array(
      Schema.Struct({ type: Schema.Literal("summary_text"), text: Schema.String }),
    ),
    encrypted_content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("function_call"),
    id: Schema.optionalKey(Schema.String),
    call_id: Schema.NonEmptyString,
    name: Schema.NonEmptyString,
    namespace: Schema.optionalKey(Schema.String),
    arguments: Schema.String,
    status: Schema.optionalKey(Schema.Literal("completed")),
  }),
]);

const Terminal = Schema.Struct({
  status: Schema.Literal("completed"),
  output: Schema.Array(Item),
  usage: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ input_tokens: Schema.Natural, output_tokens: Schema.Natural })),
  ),
});

const Continuation = Schema.Struct({
  protocol: Schema.Literal("responses"),
  items: Schema.Array(Item),
});

const normalizedOutput = (
  description: ModelDescription,
  items: ReadonlyArray<typeof Item.Type>,
) => {
  const output: Output[] = [];
  const calls = new Set<string>();

  for (const item of items) {
    if (item.type === "message") {
      for (const content of item.content)
        output.push({
          type: "text",
          text: content.type === "output_text" ? content.text : content.refusal,
        });
    } else if (item.type === "function_call") {
      if (calls.has(item.call_id))
        throw interrupted(description.provider, "The model returned duplicate tool calls.");
      Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(item.arguments);
      calls.add(item.call_id);
      output.push({
        type: "tool-call",
        callId: item.call_id,
        name: item.name,
        namespace: item.namespace ?? null,
        arguments: item.arguments,
      });
    }
  }

  return output;
};

const inputItems = (items: ReadonlyArray<typeof Item.Type>): ResponseInput =>
  items.map((item) => {
    if (item.type === "message")
      return {
        type: "message",
        id: item.id,
        role: "assistant",
        status: "completed",
        content: item.content.map((content) =>
          content.type === "output_text"
            ? { type: "output_text", text: content.text, annotations: [] }
            : { type: "refusal", refusal: content.refusal },
        ),
      };

    if (item.type === "reasoning") {
      const reasoning: ResponseReasoningItem = {
        type: "reasoning",
        id: item.id,
        summary: item.summary.map((part) => ({ ...part })),
      };

      if (item.encrypted_content !== undefined)
        reasoning.encrypted_content = item.encrypted_content;

      return reasoning;
    }

    return { ...item };
  });

const responseInput = (description: ModelDescription, request: ModelRequest) => {
  const input: ResponseInput = [];

  for (const message of request.messages) {
    if (message.role === "user") input.push({ role: "user", content: message.text });
    else if (message.role === "tool")
      input.push({ type: "function_call_output", call_id: message.callId, output: message.output });
    else if (message.continuation !== null) {
      const saved = Schema.decodeUnknownSync(Continuation, { onExcessProperty: "error" })(
        message.continuation.data,
      );

      if (
        JSON.stringify(normalizedOutput(description, saved.items)) !==
        JSON.stringify(message.output)
      )
        throw invalidRequest(
          description.provider,
          "Assistant output does not match its saved continuation.",
        );
      input.push(...inputItems(saved.items));
    } else {
      for (const part of message.output) {
        if (part.type === "text") input.push({ role: "assistant", content: part.text });
        else {
          const call: ResponseFunctionToolCall = {
            type: "function_call",
            call_id: part.callId,
            name: part.name,
            arguments: part.arguments,
          };

          if (part.namespace !== null) call.namespace = part.namespace;
          input.push(call);
        }
      }
    }
  }

  return input;
};

const responseTools = (request: ModelRequest): Tool[] => {
  const tools: Tool[] = [];
  const namespaces = new Map<string, FunctionTool[]>();

  for (const tool of request.tools) {
    const definition: FunctionTool = {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: { ...tool.parameters },
      strict: true,
    };

    if (tool.namespace === null) tools.push(definition);
    else {
      let definitions = namespaces.get(tool.namespace);

      if (!definitions) {
        definitions = [];
        namespaces.set(tool.namespace, definitions);
        tools.push({
          type: "namespace",
          name: tool.namespace,
          description: "Poppet local tools.",
          tools: definitions,
        });
      }

      definitions.push(definition);
    }
  }

  return tools;
};

export const responsesModel = (
  description: ModelDescription,
  client: Effect.Effect<OpenAI, ProviderError>,
  options: InferenceOptions = {},
): ModelOperations => {
  const failure =
    options.failure ??
    ((cause: unknown) => inferenceFailure(description.provider, cause, options.classify));

  const remote = (
    status: number | undefined,
    code: string | null | undefined,
    requestId: string | null | undefined,
  ) => remoteFailure(description.provider, status, code, requestId, options.classify);

  return {
    description,
    stream: (request) =>
      modelStream(
        description,
        request,
        (decoded, signal) =>
          Effect.gen(function* () {
            const input = yield* Effect.try({
              try: () => responseInput(description, decoded),
              catch: (cause) =>
                cause instanceof ProviderError
                  ? cause
                  : invalidRequest(description.provider, "The Responses continuation is invalid."),
            });

            const sdk = yield* client;

            const parameters: ResponseCreateParamsStreaming = {
              model: description.id,
              input,
              instructions: decoded.instructions,
              tools: responseTools(decoded),
              tool_choice: decoded.settings.toolChoice ?? "auto",
              store: false,
              stream: true,
              include: ["reasoning.encrypted_content"],
            };

            if (decoded.settings.maxOutputTokens !== undefined)
              parameters.max_output_tokens = decoded.settings.maxOutputTokens;

            if (decoded.settings.reasoningSummary) parameters.reasoning = { summary: "auto" };

            const stream = yield* Effect.tryPromise({
              try: () =>
                sdk.responses.create(parameters, {
                  signal,
                  headers: options.headers?.(decoded),
                }),
              catch: (cause) => failure(cause),
            });

            const events = async function* (): AsyncGenerator<ModelEvent> {
              let terminal: typeof Terminal.Type | null = null;
              const completedItems = new Map<number, typeof Item.Type>();
              let reasoningItem: string | null = null;
              let reasoningSummary = 0;

              try {
                for await (const event of stream) {
                  if (terminal !== null)
                    throw interrupted(
                      description.provider,
                      "The stream continued after its terminal response.",
                    );

                  if (event.type === "response.output_text.delta") {
                    const delta = Schema.decodeUnknownSync(Schema.Struct({ delta: Schema.String }))(
                      event,
                    );

                    yield { type: "text-delta", text: delta.delta };
                  } else if (
                    event.type === "response.reasoning_summary_text.delta" &&
                    decoded.settings.reasoningSummary
                  ) {
                    const delta = Schema.decodeUnknownSync(
                      Schema.Struct({
                        delta: Schema.String,
                        item_id: Schema.NonEmptyString,
                        summary_index: Schema.Natural,
                      }),
                    )(event);

                    if (delta.delta.length === 0) continue;

                    // Summary parts are separate sections, even when their text has no newlines.
                    if (
                      reasoningItem !== null &&
                      (reasoningItem !== delta.item_id || reasoningSummary !== delta.summary_index)
                    )
                      yield { type: "reasoning-delta", text: "\n\n" };

                    reasoningItem = delta.item_id;
                    reasoningSummary = delta.summary_index;
                    yield { type: "reasoning-delta", text: delta.delta };
                  } else if (event.type === "response.output_item.done") {
                    if (
                      !Number.isSafeInteger(event.output_index) ||
                      event.output_index < 0 ||
                      completedItems.has(event.output_index)
                    )
                      throw interrupted(
                        description.provider,
                        "The stream returned an invalid output index.",
                      );
                    completedItems.set(
                      event.output_index,
                      Schema.decodeUnknownSync(Item)(event.item),
                    );
                  } else if (event.type === "response.completed")
                    terminal = Schema.decodeUnknownSync(Terminal)(event.response);
                  else if (event.type === "response.failed" || event.type === "error") {
                    const code = event.type === "error" ? event.code : event.response.error?.code;
                    throw remote(undefined, code, undefined);
                  } else if (event.type === "response.incomplete")
                    throw interrupted(
                      description.provider,
                      "The model reported incomplete inference.",
                    );
                }

                if (!terminal)
                  throw interrupted(
                    description.provider,
                    "The stream ended without completed inference.",
                  );

                // ChatGPT can omit terminal output; completed item events retain the authoritative items.
                for (const [index, item] of terminal.output.entries()) {
                  if (!completedItems.has(index)) completedItems.set(index, item);
                }

                const items = inIndexOrder(completedItems, () =>
                  interrupted(description.provider, "The stream omitted an output item."),
                );

                const output = normalizedOutput(description, items);

                const response: Completion = {
                  output,
                  continuation: {
                    version: 1,
                    provider: description.provider,
                    model: description.id,
                    data: { protocol: "responses", items },
                  },
                  finishReason: output.some((part) => part.type === "tool-call")
                    ? "tool-calls"
                    : items.some(
                          (item) =>
                            item.type === "message" &&
                            item.content.some((part) => part.type === "refusal"),
                        )
                      ? "refusal"
                      : "stop",
                  usage: terminal.usage
                    ? {
                        inputTokens: terminal.usage.input_tokens,
                        outputTokens: terminal.usage.output_tokens,
                      }
                    : null,
                };

                yield {
                  type: "completed",
                  response: Schema.decodeUnknownSync(Completion)(response),
                };
              } catch (cause) {
                if (cause instanceof Schema.SchemaError || cause instanceof SyntaxError)
                  throw interrupted(
                    description.provider,
                    "The model returned a malformed Responses stream.",
                  );
                throw cause;
              } finally {
                stream.controller.abort();
              }
            };

            return events();
          }),
        failure,
      ),
  };
};
