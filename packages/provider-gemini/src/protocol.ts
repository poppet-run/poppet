import { randomUUID } from "node:crypto";

import { readBoundedText, timeout } from "@poppet/io";
import {
  Completion,
  ProviderError,
  Tool,
  interrupted,
  invalidRequest,
  userAgent,
} from "@poppet/provider";
import type {
  HttpFetch,
  ModelDescription,
  ModelEvent,
  ModelOperations,
  ModelRequest,
  Output,
  ProviderId,
} from "@poppet/provider";
import { modelStream, remoteFailure, userParts } from "@poppet/provider/protocol";
import type { Redacted } from "effect";
import { Effect, Option, Redacted as RedactedValue, Schema } from "effect";

const provider: ProviderId = "gemini";

const supportedImageTypes = new Set<string>(["image/png", "image/jpeg", "image/webp"]);

const ApiError = Schema.Struct({
  code: Schema.optionalKey(Schema.Int),
  message: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  details: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});

const ErrorBody = Schema.Union([
  Schema.Struct({ error: ApiError }),
  Schema.Tuple([Schema.Struct({ error: ApiError })]),
]);

const ErrorDetail = Schema.Struct({
  "@type": Schema.String,
  reason: Schema.optionalKey(Schema.String),
  violations: Schema.optionalKey(
    Schema.Array(Schema.Struct({ quotaId: Schema.optionalKey(Schema.String) })),
  ),
});

const FunctionCall = Schema.StructWithRest(
  Schema.Struct({
    name: Schema.NonEmptyString,
    args: Schema.optionalKey(Schema.JsonObject),
    id: Schema.optionalKey(Schema.NonEmptyString),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

const Part = Schema.StructWithRest(
  Schema.Struct({
    text: Schema.optionalKey(Schema.String),
    thought: Schema.optionalKey(Schema.Boolean),
    thoughtSignature: Schema.optionalKey(Schema.String),
    functionCall: Schema.optionalKey(FunctionCall),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

type Part = typeof Part.Type;

const Chunk = Schema.Struct({
  candidates: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        index: Schema.optionalKey(Schema.Natural),
        finishReason: Schema.optionalKey(Schema.String),
        content: Schema.optionalKey(
          Schema.Struct({
            role: Schema.optionalKey(Schema.String),
            parts: Schema.optionalKey(Schema.Array(Part)),
          }),
        ),
      }),
    ),
  ),
  usageMetadata: Schema.optionalKey(
    Schema.Struct({
      promptTokenCount: Schema.optionalKey(Schema.Natural),
      candidatesTokenCount: Schema.optionalKey(Schema.Natural),
      thoughtsTokenCount: Schema.optionalKey(Schema.Natural),
    }),
  ),
  promptFeedback: Schema.optionalKey(
    Schema.Struct({ blockReason: Schema.optionalKey(Schema.String) }),
  ),
  error: Schema.optionalKey(ApiError),
});

const Call = Schema.Struct({
  callId: Schema.NonEmptyString,
  name: Tool.fields.name,
  namespace: Tool.fields.namespace,
});

const Continuation = Schema.Struct({
  protocol: Schema.Literal("generate-content"),
  parts: Schema.Array(Part),
  calls: Schema.Array(Call),
});

type Call = typeof Call.Type;

const reasonFor = (
  status: number | undefined,
  error: typeof ApiError.Type | undefined,
): ProviderError["reason"] => {
  const details = (error?.details ?? []).flatMap((detail) =>
    Option.toArray(Schema.decodeUnknownOption(ErrorDetail)(detail)),
  );

  if (
    status === 401 ||
    error?.status === "UNAUTHENTICATED" ||
    details.some((detail) => detail.reason === "API_KEY_INVALID")
  ) {
    return "authentication";
  }

  if (status === 403 || error?.status === "PERMISSION_DENIED") {
    return "permission";
  }

  if (status === 429 || error?.status === "RESOURCE_EXHAUSTED") {
    // A daily quota does not recover within minutes, unlike a per-minute rate limit.
    return details.some((detail) =>
      detail.violations?.some((violation) => violation.quotaId?.includes("PerDay")),
    )
      ? "quota"
      : "rate-limit";
  }

  if (
    status === 400 &&
    /token/i.test(error?.message ?? "") &&
    /exceed|too (long|large)|limit/i.test(error?.message ?? "")
  ) {
    return "context-limit";
  }

  if (
    (status ?? 0) >= 500 ||
    ["UNAVAILABLE", "INTERNAL", "DEADLINE_EXCEEDED"].includes(error?.status ?? "")
  ) {
    return "temporary";
  }

  return "invalid-request";
};

export const apiFailure = (status: number | undefined, error: typeof ApiError.Type | undefined) => {
  const reason = reasonFor(status, error);

  return remoteFailure(provider, status, error?.status, undefined, () => reason);
};

export const httpFailure = async (response: Response, signal?: AbortSignal) => {
  let error: typeof ApiError.Type | undefined;

  try {
    const text = await readBoundedText(
      response.body ?? new ReadableStream(),
      65_536,
      () => new RangeError("The error body is too large."),
      signal,
    );

    const body = Schema.decodeUnknownSync(Schema.fromJsonString(ErrorBody))(text);
    error = "error" in body ? body.error : body[0].error;
  } catch {
    await response.body?.cancel().catch(() => undefined);
  }

  return apiFailure(response.status, error);
};

export const geminiFailure = (cause: unknown): ProviderError =>
  cause instanceof ProviderError
    ? cause
    : new ProviderError({
        provider,
        reason: "temporary",
        message: "The gemini request could not complete. No automatic retry was attempted.",
      });

export const keyHeaders = (key: Redacted.Redacted<string>) => ({
  "User-Agent": userAgent,
  "x-goog-api-key": RedactedValue.value(key),
});

const wireName = (tool: Pick<Tool, "name" | "namespace">) =>
  tool.namespace === null ? tool.name : `${tool.namespace}__${tool.name}`;

const toolNames = (request: ModelRequest) => {
  const names = new Map<string, Tool>();

  for (const tool of request.tools) {
    const name = wireName(tool);

    if (name.length > 64 || names.has(name)) {
      throw invalidRequest(provider, "Tool names are too long or collide for Gemini.");
    }

    names.set(name, tool);
  }

  return names;
};

const isPlainText = (part: Part): part is Part & { readonly text: string } =>
  part.text !== undefined &&
  Object.keys(part).every((key) => ["text", "thought", "thoughtSignature"].includes(key));

// Streaming splits one logical part across chunks, and its signature arrives with the last
// fragment, so text joins the previous part until that part is signed.
const appendPart = (parts: Array<Part>, part: Part) => {
  const previous = parts.at(-1);

  if (
    previous !== undefined &&
    isPlainText(previous) &&
    isPlainText(part) &&
    previous.thoughtSignature === undefined &&
    (previous.thought ?? false) === (part.thought ?? false)
  ) {
    parts[parts.length - 1] = { ...part, text: previous.text + part.text };

    return;
  }

  parts.push(part);
};

const normalizedOutput = (parts: ReadonlyArray<Part>, calls: ReadonlyArray<Call>) => {
  const output: Array<Output> = [];
  let text = "";
  let callIndex = 0;

  const flush = () => {
    if (text.length > 0) {
      output.push({ type: "text", text });
      text = "";
    }
  };

  for (const part of parts) {
    if (part.functionCall !== undefined) {
      const call = calls[callIndex++];

      if (call === undefined) {
        throw invalidRequest(provider, "The Gemini continuation is invalid.");
      }

      flush();
      output.push({
        type: "tool-call",
        callId: call.callId,
        name: call.name,
        namespace: call.namespace,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      });
    } else if (part.text !== undefined && part.thought !== true) {
      text += part.text;
    }
  }

  if (callIndex !== calls.length) {
    throw invalidRequest(provider, "The Gemini continuation is invalid.");
  }

  flush();

  return output;
};

type Content = { role: "user" | "model"; parts: Array<Schema.JsonObject> };

const contents = (description: ModelDescription, request: ModelRequest) => {
  const result: Array<Content> = [];
  const calls = new Map<string, { readonly name: string; readonly id: string | undefined }>();

  for (const message of request.messages) {
    if (message.role === "user") {
      const parts = userParts(description, request, message).map((part) => {
        if (part.type === "text") {
          return { text: part.text };
        }

        if (!supportedImageTypes.has(part.mediaType)) {
          throw invalidRequest(provider, "Gemini accepts PNG, JPEG, and WebP images.");
        }

        return { inlineData: { mimeType: part.mediaType, data: part.base64 } };
      });

      result.push({ role: "user", parts: parts.length === 0 ? [{ text: "" }] : parts });
    } else if (message.role === "tool") {
      const call = calls.get(message.callId);

      if (call === undefined) {
        throw invalidRequest(provider, "A tool result does not follow its tool call.");
      }

      const part = {
        functionResponse: {
          ...(call.id !== undefined && { id: call.id }),
          name: call.name,
          response: { output: message.output },
        },
      };

      const previous = result.at(-1);

      // Gemini expects the results of parallel calls together in one turn.
      if (
        previous?.role === "user" &&
        previous.parts.every((entry) => "functionResponse" in entry)
      ) {
        previous.parts.push(part);
      } else {
        result.push({ role: "user", parts: [part] });
      }
    } else if (message.continuation !== null) {
      const saved = Schema.decodeUnknownSync(Continuation, { onExcessProperty: "error" })(
        message.continuation.data,
      );

      if (
        JSON.stringify(normalizedOutput(saved.parts, saved.calls)) !==
        JSON.stringify(message.output)
      ) {
        throw invalidRequest(provider, "Assistant output does not match its saved continuation.");
      }

      let index = 0;

      for (const part of saved.parts) {
        const call = part.functionCall === undefined ? undefined : saved.calls[index++];

        if (call !== undefined && part.functionCall !== undefined) {
          calls.set(call.callId, { name: part.functionCall.name, id: part.functionCall.id });
        }
      }

      if (saved.parts.length > 0) {
        result.push({ role: "model", parts: saved.parts.map((part) => ({ ...part })) });
      }
    } else {
      const parts = message.output.map((part) => {
        if (part.type === "text") {
          return { text: part.text };
        }

        calls.set(part.callId, { name: wireName(part), id: undefined });

        return {
          functionCall: {
            name: wireName(part),
            args: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(
              part.arguments,
            ),
          },
        };
      });

      if (parts.length > 0) {
        result.push({ role: "model", parts });
      }
    }
  }

  return result;
};

const requestBody = (
  description: ModelDescription,
  request: ModelRequest,
  names: ReadonlyMap<string, Tool>,
  thinking: boolean,
) => {
  const { temperature, maxOutputTokens, toolChoice, reasoningSummary } = request.settings;

  const generationConfig = {
    ...(temperature !== undefined && { temperature }),
    ...(maxOutputTokens !== undefined && { maxOutputTokens }),
    ...(thinking && reasoningSummary === true && { thinkingConfig: { includeThoughts: true } }),
  };

  return {
    contents: contents(description, request),
    ...(request.instructions.length > 0 && {
      systemInstruction: { parts: [{ text: request.instructions }] },
    }),
    ...(names.size > 0 && {
      tools: [
        {
          functionDeclarations: [...names.entries()].map(([name, tool]) => ({
            name,
            description: tool.description,
            parametersJsonSchema: tool.parameters,
          })),
        },
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: { auto: "AUTO", required: "ANY", none: "NONE" }[toolChoice ?? "auto"],
        },
      },
    }),
    ...(Object.keys(generationConfig).length > 0 && { generationConfig }),
  };
};

async function* serverEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: Array<string> = [];

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");

      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");

        if (line.length === 0) {
          if (data.length > 0) {
            yield data.join("\n");
            data = [];
          }
        } else if (line.startsWith("data:")) {
          data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const stopped = (code: string | undefined, message: string) =>
  new ProviderError({ provider, reason: "interrupted", message, code });

export const geminiModel = (
  description: ModelDescription,
  options: {
    readonly key: Effect.Effect<Redacted.Redacted<string>, ProviderError>;
    readonly http: HttpFetch;
    readonly baseUrl: string;
    readonly thinking: boolean;
  },
): ModelOperations => ({
  description,
  stream: (request) =>
    modelStream(
      description,
      request,
      (decoded, signal) =>
        Effect.gen(function* () {
          const names = yield* Effect.try({
            try: () => toolNames(decoded),
            catch: (cause) =>
              cause instanceof ProviderError
                ? cause
                : invalidRequest(provider, "The tool definitions are invalid."),
          });

          const body = yield* Effect.try({
            try: () => requestBody(description, decoded, names, options.thinking),
            catch: (cause) =>
              cause instanceof ProviderError
                ? cause
                : invalidRequest(provider, "The Gemini continuation is invalid."),
          });

          const key = yield* options.key;
          const requestTimeout = yield* timeout("providerRequestSeconds");
          const headersDeadline = new AbortController();

          const stream = yield* Effect.tryPromise({
            try: async () => {
              const opened = await options.http(
                `${options.baseUrl}/models/${encodeURIComponent(description.id)}:streamGenerateContent?alt=sse`,
                {
                  method: "POST",
                  headers: { ...keyHeaders(key), "Content-Type": "application/json" },
                  body: JSON.stringify(body),
                  signal: AbortSignal.any([signal, headersDeadline.signal]),
                },
              );

              if (!opened.ok) {
                throw await httpFailure(opened, signal);
              }

              if (opened.body === null) {
                throw interrupted(provider, "The stream ended without successful completion.");
              }

              return opened.body;
            },
            catch: geminiFailure,
          }).pipe(
            Effect.timeoutOrElse({
              duration: requestTimeout,
              orElse: () => {
                headersDeadline.abort();

                return Effect.fail(
                  interrupted(provider, "The inference request timed out or was interrupted."),
                );
              },
            }),
          );

          const events = async function* (): AsyncGenerator<ModelEvent> {
            const parts: Array<Part> = [];
            const calls: Array<Call> = [];
            let finished = false;
            let usage: Completion["usage"] = null;

            try {
              for await (const data of serverEvents(stream)) {
                const chunk = Schema.decodeUnknownSync(Schema.fromJsonString(Chunk))(data);

                if (chunk.error !== undefined) {
                  throw apiFailure(chunk.error.code, chunk.error);
                }

                if (chunk.promptFeedback?.blockReason !== undefined) {
                  throw new ProviderError({
                    provider,
                    reason: "invalid-request",
                    message: "Gemini blocked the request.",
                    code: chunk.promptFeedback.blockReason,
                  });
                }

                if (chunk.usageMetadata !== undefined) {
                  usage = {
                    inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
                    outputTokens:
                      (chunk.usageMetadata.candidatesTokenCount ?? 0) +
                      (chunk.usageMetadata.thoughtsTokenCount ?? 0),
                  };
                }

                const candidates = chunk.candidates ?? [];
                const candidate = candidates[0];

                if (candidate === undefined) {
                  continue;
                }

                if (candidates.length !== 1 || (candidate.index ?? 0) !== 0) {
                  throw interrupted(provider, "The model returned an invalid candidate sequence.");
                }

                const received = candidate.content?.parts ?? [];

                if (finished && received.length > 0) {
                  throw interrupted(provider, "The stream continued after its terminal response.");
                }

                for (const part of received) {
                  if (
                    part.text === undefined &&
                    part.functionCall === undefined &&
                    part.thoughtSignature === undefined
                  ) {
                    throw interrupted(provider, "The model returned an unsupported part.");
                  }

                  if (part.functionCall !== undefined) {
                    const tool = names.get(part.functionCall.name);
                    const callId = part.functionCall.id ?? `call_${randomUUID()}`;

                    if (
                      tool === undefined ||
                      part.thought === true ||
                      calls.some((call) => call.callId === callId)
                    ) {
                      throw interrupted(provider, "The model returned an invalid tool call.");
                    }

                    calls.push({ callId, name: tool.name, namespace: tool.namespace });
                  } else if (part.text) {
                    if (part.thought !== true) {
                      yield { type: "text-delta", text: part.text };
                    } else if (decoded.settings.reasoningSummary) {
                      yield { type: "reasoning-delta", text: part.text };
                    }
                  }

                  appendPart(parts, part);
                }

                if (candidate.finishReason === "STOP") {
                  finished = true;
                } else if (
                  candidate.finishReason !== undefined &&
                  candidate.finishReason !== "FINISH_REASON_UNSPECIFIED"
                ) {
                  throw stopped(
                    candidate.finishReason,
                    candidate.finishReason === "MAX_TOKENS"
                      ? "The model reached its output token limit before completing."
                      : "Gemini stopped the response before it completed.",
                  );
                }
              }

              if (!finished) {
                throw interrupted(provider, "The stream ended without successful completion.");
              }

              if (decoded.settings.toolChoice === "none" && calls.length > 0) {
                throw interrupted(provider, "The model returned an invalid tool call.");
              }

              const completion = Schema.decodeUnknownSync(Completion)({
                output: normalizedOutput(parts, calls),
                continuation: {
                  version: 1,
                  provider,
                  model: description.id,
                  data: { protocol: "generate-content", parts, calls },
                },
                finishReason: calls.length > 0 ? "tool-calls" : "stop",
                usage,
              });

              yield { type: "completed", response: completion };
            } catch (cause) {
              if (cause instanceof Schema.SchemaError || cause instanceof SyntaxError) {
                throw interrupted(provider, "The model returned a malformed Gemini stream.");
              }

              throw cause;
            }
          };

          return events();
        }),
      geminiFailure,
    ),
});
