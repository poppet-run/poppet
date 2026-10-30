import {
  Completion,
  Message,
  type Continuation,
  type Message as ModelMessage,
} from "@poppet/provider";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { StoreError, decodeInput, reportAs, storeFailure } from "#src/errors";
import { Id, Run, Session, SkillSnapshot, StoredMessage, ToolCall } from "#src/schema";
import { decodeRow, decodeRows } from "#src/sql";

export const SessionRow = Schema.Struct({
  ...Session.fields,
  titleAttempted: Schema.BooleanFromBit,
  skill: Schema.NullOr(Schema.fromJsonString(SkillSnapshot)),
  titleUsage: Schema.NullOr(Schema.fromJsonString(Completion.fields.usage)),
});

export const RunRow = Schema.Struct({
  ...Run.fields,
  result: Schema.NullOr(Schema.fromJsonString(Completion)),
});

export const MessageRow = Schema.Struct({
  ...StoredMessage.fields,
  message: Schema.fromJsonString(Message),
});

export const encodeMessage = Schema.encodeSync(Schema.fromJsonString(Message));

export const conflict = (message: string) => new StoreError({ reason: "conflict", message });

export const notFound = (message: string) => new StoreError({ reason: "not-found", message });

export const continuationMatches = (session: Session, continuation: Continuation) =>
  continuation.provider === session.provider && continuation.model === session.model;

/** Shared reads and writes used by the session, run, and tool-call operations. */
export const storeRecords = (sql: SqlClient.SqlClient) => {
  // Internal steps fail with SQL, schema, or store errors; public operations report StoreError.
  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql.withTransaction(effect).pipe(reportAs(storeFailure));

  const findSession = (id: string) =>
    sql`SELECT * FROM sessions WHERE id = ${id}`.pipe(decodeRow(SessionRow));

  const requireSession = (id: string) =>
    Effect.flatMap(findSession(id), (session) =>
      session === null
        ? Effect.fail(notFound("The session does not exist."))
        : Effect.succeed(session),
    );

  // A run's provider and model are its session's.
  const runs = sql`SELECT runs.*, sessions.provider, sessions.model
      FROM runs JOIN sessions ON sessions.id = runs.session_id`;

  const findRun = (id: string) => sql`${runs} WHERE runs.id = ${id}`.pipe(decodeRow(RunRow));

  const requireRun = (id: string) =>
    Effect.flatMap(findRun(id), (run) =>
      run === null ? Effect.fail(notFound("The run does not exist.")) : Effect.succeed(run),
    );

  const toolCallsFor = (runId: string) =>
    sql`SELECT * FROM tool_calls WHERE run_id = ${runId} ORDER BY position`.pipe(
      decodeRows(ToolCall),
    );

  const activeTool = (runId: string, callId: string) =>
    Effect.gen(function* () {
      const run = yield* requireRun(yield* decodeInput(Id, runId));
      const call = (yield* toolCallsFor(runId)).find((entry) => entry.callId === callId);

      if (
        run.status !== "running" ||
        !call ||
        (call.status !== "pending" && call.status !== "running")
      )
        return yield* conflict("The tool call must belong to the running run and be active.");

      return { run, call };
    });

  // Call IDs with a saved tool reply in this run, whether the call completed or reported failure.
  const repliedCalls = (runId: string) =>
    sql`SELECT json_extract(payload, '$.callId') AS call_id FROM messages
        WHERE run_id = ${runId} AND json_extract(payload, '$.role') = 'tool'`.pipe(
      decodeRows(Schema.Struct({ callId: Schema.NonEmptyString })),
      Effect.map((replies) => new Set(replies.map((reply) => reply.callId))),
    );

  // Settles unfinished calls; a call that was running may have had effects, so it is uncertain.
  const interruptTools = (runId: string, at: number, reason: string) =>
    sql`UPDATE tool_calls
        SET status = CASE WHEN status = 'running' THEN 'uncertain' ELSE 'interrupted' END,
          finished_at = MAX(created_at, COALESCE(started_at, 0), ${at}), failure_reason = ${reason}
        WHERE run_id = ${runId} AND status IN ('pending', 'running')`;

  const touch = (sessionId: string, at: number) =>
    sql`UPDATE sessions SET updated_at = MAX(updated_at, ${at}) WHERE id = ${sessionId}`;

  const append = (
    session: Session,
    runId: string | null,
    messages: ReadonlyArray<ModelMessage>,
    at: number,
  ) =>
    Effect.gen(function* () {
      for (const message of messages)
        if (
          message.role === "assistant" &&
          message.continuation !== null &&
          !continuationMatches(session, message.continuation)
        )
          return yield* new StoreError({
            reason: "invalid-request",
            message: "Continuation belongs to another provider or model. Start a new session.",
          });

      const next = yield* sql`SELECT COALESCE(MAX(position) + 1, 0) AS position
          FROM messages WHERE session_id = ${session.id}`.pipe(
        decodeRow(Schema.Struct({ position: Schema.Natural })),
      );

      const start = next?.position ?? 0;

      if (messages.length > 0)
        yield* sql`INSERT INTO messages ${sql.insert(
          messages.map((message, index) => ({
            sessionId: session.id,
            runId,
            position: start + index,
            createdAt: at,
            payload: encodeMessage(message),
          })),
        )}`;

      yield* touch(session.id, at);
    });

  return {
    transaction,
    findSession,
    requireSession,
    runs,
    findRun,
    requireRun,
    toolCallsFor,
    activeTool,
    repliedCalls,
    interruptTools,
    touch,
    append,
  };
};

export type StoreRecords = ReturnType<typeof storeRecords>;
