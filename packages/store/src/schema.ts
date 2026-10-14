import { Completion, Message, ModelRequest, ProviderId, Tool } from "@poppet/provider";
import { Schema } from "effect";

export const Id = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/));

export const ModelId = Schema.NonEmptyString.check(Schema.isTrimmed());

export const Session = Schema.Struct({
  id: Id,
  provider: ProviderId,
  model: ModelId,
  workload: ModelRequest.fields.workload,
  createdAt: Schema.Natural,
  updatedAt: Schema.Natural,
});

export const StoredMessage = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  sessionId: Id,
  runId: Schema.NullOr(Id),
  position: Schema.Natural,
  createdAt: Schema.Natural,
  message: Message,
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
  workload: ModelRequest.fields.workload,
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

export const MessageBatch = Schema.Struct({
  sessionId: Id,
  runId: Schema.NullOr(Id),
  messages: Schema.Array(Message),
});

export const ToolCall = Schema.Struct({
  runId: Id,
  callId: Schema.NonEmptyString,
  position: Schema.Natural,
  name: Tool.fields.name,
  namespace: Tool.fields.namespace,
  arguments: Schema.String,
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
    status: Schema.Literals(["failed", "interrupted", "uncertain"]),
    reason: Schema.NonEmptyString,
  }),
]);

export type ToolCall = typeof ToolCall.Type;

export type ToolOutcome = typeof ToolOutcome.Type;

export type Session = typeof Session.Type;

export type StoredMessage = typeof StoredMessage.Type;

export type Run = typeof Run.Type;

export type RunOutcome = typeof RunOutcome.Type;

export type MessageBatch = typeof MessageBatch.Type;

export interface StoreStatus {
  readonly path: string;
  readonly schemaVersion: number;
  readonly sessions: number;
  readonly messages: number;
  readonly runs: number;
}
