import { Schema } from "effect";

/** A bounded, path-safe provider name, also used in credential filenames. */
export const ProviderId = Schema.NonEmptyString.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));

/** Optional generation controls that a model can advertise as supported. */
export const GenerationSetting = Schema.Literals(["temperature", "maxOutputTokens"]);

const Name = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]{0,63}$/));

/** A tool offered to the model, with its arguments described by a JSON schema. */
export const Tool = Schema.Struct({
  name: Name,
  namespace: Schema.NullOr(Name),
  description: Schema.String,
  parameters: Schema.JsonObject,
});

/** Strict JSON Schema parameters for a tool's arguments. */
export const toolParameters = (schema: Schema.Constraint): Schema.JsonObject =>
  Schema.decodeUnknownSync(Schema.JsonObject)(
    Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" }).schema,
  );

/** Decodes a tool call's JSON arguments strictly; callers map the error. */
export const decodeToolArguments = <S extends Schema.Constraint>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema), { onExcessProperty: "error" });

/** One ordered part of an assistant response; tool arguments remain JSON text until validated. */
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

/** Versioned provider state used to continue a conversation with the same provider and model. */
export const Continuation = Schema.Struct({
  version: Schema.Literal(1),
  provider: ProviderId,
  model: Schema.NonEmptyString,
  data: Schema.JsonObject,
});

/** Media types an owner can attach; images need a model that accepts them. */
export const AttachmentType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
]);

/** A saved attachment named by a user message; its contents travel separately in the request. */
export const AttachmentReference = Schema.Struct({
  id: Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)),
  name: Schema.NonEmptyString.check(Schema.isMaxLength(255)),
  mediaType: AttachmentType,
  size: Schema.Natural,
});

/** Base64 bytes for an image, or the decoded text of a text file. */
export const AttachmentContent = Schema.Union([
  Schema.Struct({ id: AttachmentReference.fields.id, base64: Schema.String }),
  Schema.Struct({ id: AttachmentReference.fields.id, text: Schema.String }),
]);

/** Shared conversation history that each provider translates into its own request format. */
export const Message = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.optionalKey(Schema.Array(AttachmentReference)),
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

/** Model identity and supported controls; null capacity limits mean they are unknown. */
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

/** One inference turn, including history, available tools, and explicitly requested settings. */
export const ModelRequest = Schema.Struct({
  sessionId: Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)),
  workload: Schema.Literals(["assistant", "coding"]),
  instructions: Schema.String,
  messages: Schema.Array(Message),
  tools: Schema.Array(Tool),
  /** Contents for every attachment the messages reference. */
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

/** The full result of one inference turn, including continuation state and optional token usage. */
export const Completion = Schema.Struct({
  output: Schema.Array(Output),
  continuation: Continuation,
  finishReason: Schema.Literals(["stop", "tool-calls", "refusal"]),
  usage: Schema.NullOr(
    Schema.Struct({ inputTokens: Schema.Natural, outputTokens: Schema.Natural }),
  ),
});

/** Incremental answer or readable reasoning text, followed by one final result. */
export const ModelEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text-delta"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("reasoning-delta"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("completed"), response: Completion }),
]);

export type ProviderId = typeof ProviderId.Type;

export type Tool = typeof Tool.Type;

export type Output = typeof Output.Type;

export type Continuation = typeof Continuation.Type;

export type AttachmentType = typeof AttachmentType.Type;

export type AttachmentReference = typeof AttachmentReference.Type;

export type AttachmentContent = typeof AttachmentContent.Type;

export type Message = typeof Message.Type;

export type ModelDescription = typeof ModelDescription.Type;

export type ModelRequest = typeof ModelRequest.Type;

export type Completion = typeof Completion.Type;

export type ModelEvent = typeof ModelEvent.Type;
