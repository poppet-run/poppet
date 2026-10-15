import { Completion, Message, ModelRequest, ProviderId, Tool } from "@poppet/provider";
import { Schema } from "effect";

/** A bounded identifier shared by persisted sessions, runs, and task records. */
export const Id = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/));

/** A provider's model identifier without leading or trailing whitespace. */
export const ModelId = Schema.NonEmptyString.check(Schema.isTrimmed());

/** A sanitized single-line title of at most 80 Unicode code points. */
export const SessionTitle = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      [...value].length <= 80 &&
      value === value.trim() &&
      !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value),
  ),
);

/** A saved conversation whose provider, model, and workload stay fixed across runs. */
export const Session = Schema.Struct({
  id: Id,
  provider: ProviderId,
  model: ModelId,
  workload: ModelRequest.fields.workload,
  createdAt: Schema.Natural,
  updatedAt: Schema.Natural,
  title: Schema.NullOr(SessionTitle),
  titleSource: Schema.NullOr(Schema.Literals(["fallback", "generated", "manual", "task"])),
  titleAttempted: Schema.Boolean,
  titleUsage: Completion.fields.usage,
});

/** A message ordered within a session; runId is null for history saved outside a run. */
export const StoredMessage = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  sessionId: Id,
  runId: Schema.NullOr(Id),
  position: Schema.Natural,
  createdAt: Schema.Natural,
  message: Message,
});

/** A run starts pending, becomes running, then ends completed, failed, or interrupted. */
export const RunStatus = Schema.Literals([
  "pending",
  "running",
  "completed",
  "failed",
  "interrupted",
]);

/** Durable execution state for one user request, with timestamps in Unix milliseconds. */
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

/** The terminal result used to finish an active run. */
export const RunOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("completed"), response: Completion }),
  Schema.Struct({
    status: Schema.Literals(["failed", "interrupted"]),
    reason: Schema.NonEmptyString,
  }),
]);

/** Messages appended together to one session, optionally through its active run. */
export const MessageBatch = Schema.Struct({
  sessionId: Id,
  runId: Schema.NullOr(Id),
  messages: Schema.Array(Message),
});

/** A saved tool invocation; uncertain means its effects could not be confirmed. */
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

/** A tool's confirmed output or the reason execution failed, stopped, or became uncertain. */
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

/** Database location, migration version, and saved record counts for status commands. */
export interface StoreStatus {
  readonly path: string;
  readonly schemaVersion: number;
  readonly sessions: number;
  readonly messages: number;
  readonly runs: number;
}
