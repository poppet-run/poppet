import { Schema } from "effect";

export const ProviderId = Schema.NonEmptyString.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));

export const GenerationSetting = Schema.Literals(["temperature", "maxOutputTokens"]);

const Name = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]{0,63}$/));

export const Tool = Schema.Struct({
  name: Name,
  namespace: Schema.NullOr(Name),
  description: Schema.String,
  parameters: Schema.JsonObject,
});

export const toolParameters = (schema: Schema.Constraint): Schema.JsonObject =>
  Schema.decodeUnknownSync(Schema.JsonObject)(
    Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" }).schema,
  );

export const decodeToolArguments = <S extends Schema.Constraint>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema), { onExcessProperty: "error" });

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

export const AttachmentType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
]);

export const AttachmentReference = Schema.Struct({
  id: Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)),
  name: Schema.NonEmptyString.check(Schema.isMaxLength(255)),
  mediaType: AttachmentType,
  size: Schema.Natural,
});

export const AttachmentContent = Schema.Union([
  Schema.Struct({ id: AttachmentReference.fields.id, base64: Schema.String }),
  Schema.Struct({ id: AttachmentReference.fields.id, text: Schema.String }),
]);

export const Message = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.optionalKey(Schema.Array(AttachmentReference)),
    skills: Schema.optionalKey(
      Schema.Array(Schema.Struct({ name: Schema.String, content: Schema.String })),
    ),
  }),
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
  capabilities: Schema.Struct({
    tools: Schema.Boolean,
    images: Schema.Boolean,
    generationSettings: Schema.Array(GenerationSetting),
    contextWindow: Schema.NullOr(Schema.Natural),
    maxOutputTokens: Schema.NullOr(Schema.Natural),
  }),
});

export const ModelRequest = Schema.Struct({
  sessionId: Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)),
  instructions: Schema.String,
  messages: Schema.Array(Message),
  tools: Schema.Array(Tool),
  attachments: Schema.optionalKey(Schema.Array(AttachmentContent)),
  settings: Schema.Struct({
    temperature: Schema.optionalKey(
      Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
    ),
    maxOutputTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    toolChoice: Schema.optionalKey(Schema.Literals(["auto", "required", "none"])),
    reasoningSummary: Schema.optionalKey(Schema.Boolean),
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
  Schema.Struct({ type: Schema.Literal("reasoning-delta"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("completed"), response: Completion }),
]);

export type ProviderId = typeof ProviderId.Type;

export type Tool = typeof Tool.Type;

export type Output = typeof Output.Type;

export const outputText = (output: ReadonlyArray<Output>) =>
  output.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

export type Continuation = typeof Continuation.Type;

export type AttachmentType = typeof AttachmentType.Type;

export type AttachmentReference = typeof AttachmentReference.Type;

export type AttachmentContent = typeof AttachmentContent.Type;

export type Message = typeof Message.Type;

export type ModelDescription = typeof ModelDescription.Type;

export type ModelRequest = typeof ModelRequest.Type;

export type Completion = typeof Completion.Type;

export type ModelEvent = typeof ModelEvent.Type;
