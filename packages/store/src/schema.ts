import { AttachmentReference, Completion, Message, ProviderId, Tool } from "@poppet/provider";
import { Schema } from "effect";

export const Id = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/));

export const DeliveryDestination = Schema.Struct({
  adapter: Id,
  account: Id,
  ownerId: Id,
  scopeId: Id,
  parentId: Id,
  conversationId: Id,
});

export type DeliveryDestination = typeof DeliveryDestination.Type;

export const ModelId = Schema.NonEmptyString.check(Schema.isTrimmed());

export const SessionSearchQuery = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(256),
);

export const SessionSearchMatch = Schema.Struct({
  sessionId: Id,
  messageId: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.NullOr(Schema.String),
  createdAt: Schema.Natural,
  role: Schema.Literals(["user", "assistant"]),
  excerpt: Schema.String,
});

export interface SessionSearchResult {
  readonly matches: ReadonlyArray<typeof SessionSearchMatch.Type>;
  readonly truncated: boolean;
}

export const SessionReadQuery = Schema.Struct({
  sessionId: Id,
  aroundMessageId: Schema.NullOr(SessionSearchMatch.fields.messageId),
  afterMessageId: Schema.NullOr(SessionSearchMatch.fields.messageId),
}).check(
  Schema.makeFilter((query) => query.aroundMessageId === null || query.afterMessageId === null),
);

export type SessionReadQuery = typeof SessionReadQuery.Type;

export const SessionReadMessage = Schema.Struct({
  messageId: SessionSearchMatch.fields.messageId,
  role: SessionSearchMatch.fields.role,
  createdAt: Schema.Natural,
  text: Schema.String,
  truncated: Schema.Boolean,
});

export const SessionReadResult = Schema.Struct({
  sessionId: Id,
  title: Schema.NullOr(Schema.String),
  messages: Schema.Array(SessionReadMessage),
  nextAfterMessageId: Schema.NullOr(SessionSearchMatch.fields.messageId),
  truncated: Schema.Boolean,
});

export type SessionReadResult = typeof SessionReadResult.Type;

export const SessionTitle = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      [...value].length <= 80 &&
      value === value.trim() &&
      !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value),
  ),
);

export const SkillName = Id;

export const SkillSnapshot = Schema.Struct({
  name: SkillName,
  content: Schema.String.check(
    Schema.makeFilter((text) => Buffer.byteLength(text) <= 8192 && !text.includes("\0")),
  ),
});

export type SkillSnapshot = typeof SkillSnapshot.Type;

export const Session = Schema.Struct({
  id: Id,
  provider: ProviderId,
  model: ModelId,
  createdAt: Schema.Natural,
  updatedAt: Schema.Natural,
  title: Schema.NullOr(SessionTitle),
  titleSource: Schema.NullOr(Schema.Literals(["fallback", "generated", "manual", "task"])),
  titleAttempted: Schema.Boolean,
  titleUsage: Completion.fields.usage,
  skill: Schema.NullOr(SkillSnapshot),
});

export const StoredMessage = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  sessionId: Id,
  runId: Schema.NullOr(Id),
  position: Schema.Natural,
  createdAt: Schema.Natural,
  message: Message,
});

export const NewAttachment = Schema.Struct({
  id: AttachmentReference.fields.id,
  name: AttachmentReference.fields.name,
  mediaType: AttachmentReference.fields.mediaType,
  body: Schema.Uint8Array,
});

export const SavedAttachment = Schema.Struct({
  id: AttachmentReference.fields.id,
  mediaType: AttachmentReference.fields.mediaType,
  body: Schema.Uint8Array,
});

export const RunStatus = Schema.Literals([
  "pending",
  "running",
  "completed",
  "failed",
  "interrupted",
]);

export const Run = Schema.Struct({
  id: Id,
  sessionId: Id,
  provider: ProviderId,
  model: ModelId,
  status: RunStatus,
  createdAt: Schema.Natural,
  startedAt: Schema.NullOr(Schema.Natural),
  finishedAt: Schema.NullOr(Schema.Natural),
  result: Schema.NullOr(Completion),
  failureReason: Schema.NullOr(Schema.NonEmptyString),
});

export const RunOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("completed"), response: Completion }),
  Schema.Struct({
    status: Schema.Literals(["failed", "interrupted"]),
    reason: Schema.NonEmptyString,
  }),
]);

export const ToolCall = Schema.Struct({
  runId: Id,
  callId: Schema.NonEmptyString,
  position: Schema.Natural,
  name: Tool.fields.name,
  namespace: Tool.fields.namespace,
  arguments: Schema.String,
  serverId: Schema.NullOr(Schema.NonEmptyString),
  toolName: Schema.NullOr(Schema.NonEmptyString),
  status: Schema.Literals([
    "pending",
    "running",
    "completed",
    "failed",
    "interrupted",
    "uncertain",
  ]),
  createdAt: Schema.Natural,
  startedAt: Schema.NullOr(Schema.Natural),
  finishedAt: Schema.NullOr(Schema.Natural),
  output: Schema.NullOr(Schema.String),
  failureReason: Schema.NullOr(Schema.NonEmptyString),
});

export const ToolOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("completed"), output: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: Schema.NonEmptyString,
    output: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literals(["failed", "interrupted", "uncertain"]),
    reason: Schema.NonEmptyString,
  }),
]);

export type NewAttachment = typeof NewAttachment.Type;

export type SavedAttachment = typeof SavedAttachment.Type;

export type ToolCall = typeof ToolCall.Type;

export type ToolOutcome = typeof ToolOutcome.Type;

export type Session = typeof Session.Type;

export type StoredMessage = typeof StoredMessage.Type;

export type Run = typeof Run.Type;

export type RunOutcome = typeof RunOutcome.Type;

export interface StoreStatus {
  readonly path: string;
  readonly schemaVersion: number;
  readonly sessions: number;
  readonly messages: number;
  readonly runs: number;
}
