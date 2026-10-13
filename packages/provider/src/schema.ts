import { Schema } from "effect";

export const ProviderId = Schema.Literals(["openai-chatgpt", "opencode-go", "openrouter"]);

export const Protocol = Schema.Literals(["responses", "chat-completions"]);

export const GenerationSetting = Schema.Literals(["temperature", "maxOutputTokens"]);

const Name = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]{0,63}$/));

export const Tool = Schema.Struct({
  name: Name,
  namespace: Schema.NullOr(Name),
  description: Schema.String,
  parameters: Schema.JsonObject,
});

export const Output = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool-call"),
    callId: Schema.NonEmptyString,
    name: Name,
    namespace: Schema.NullOr(Name),
    arguments: Schema.String,
  }),
]);

export const Continuation = Schema.Struct({
  version: Schema.Literal(1),
  provider: ProviderId,
  model: Schema.NonEmptyString,
  data: Schema.JsonObject,
});

export const Message = Schema.Union([
  Schema.Struct({ role: Schema.Literal("user"), text: Schema.String }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    output: Schema.Array(Output),
    continuation: Schema.NullOr(Continuation),
  }),
  Schema.Struct({
    role: Schema.Literal("tool"),
    callId: Schema.NonEmptyString,
    output: Schema.String,
  }),
]);

export const ModelDescription = Schema.Struct({
  provider: ProviderId,
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  protocol: Protocol,
  capabilities: Schema.Struct({
    tools: Schema.Boolean,
    generationSettings: Schema.Array(GenerationSetting),
    contextWindow: Schema.NullOr(Schema.Natural),
    maxOutputTokens: Schema.NullOr(Schema.Natural),
  }),
});

export const ModelRequest = Schema.Struct({
  sessionId: Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)),
  workload: Schema.Literals(["assistant", "coding"]),
  instructions: Schema.String,
  messages: Schema.Array(Message),
  tools: Schema.Array(Tool),
  settings: Schema.Struct({
    temperature: Schema.optionalKey(
      Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
    ),
    maxOutputTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    toolChoice: Schema.optionalKey(Schema.Literals(["auto", "required", "none"])),
  }),
});

export const Completion = Schema.Struct({
  output: Schema.Array(Output),
  continuation: Continuation,
  finishReason: Schema.Literals(["stop", "tool-calls", "refusal"]),
  usage: Schema.NullOr(
    Schema.Struct({ inputTokens: Schema.Natural, outputTokens: Schema.Natural }),
  ),
});

export const ModelEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text-delta"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("completed"), response: Completion }),
]);

export type ProviderId = typeof ProviderId.Type;

export type Protocol = typeof Protocol.Type;

export type Tool = typeof Tool.Type;

export type Output = typeof Output.Type;

export type Continuation = typeof Continuation.Type;

export type Message = typeof Message.Type;

export type ModelDescription = typeof ModelDescription.Type;

export type ModelRequest = typeof ModelRequest.Type;

export type Completion = typeof Completion.Type;

export type ModelEvent = typeof ModelEvent.Type;
