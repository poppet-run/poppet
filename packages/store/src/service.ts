import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import {
  Completion,
  Message,
  ProviderId,
  type Continuation,
  type Message as ModelMessage,
} from "@poppet/provider";
import { Context, DateTime, Effect, Layer, Schema } from "effect";

import { StoreDatabase, StoreDatabaseLive } from "#src/database";
import { StoreError, storageFailure, corruptRecord, readRecord } from "#src/errors";
import {
  Id,
  MessageBatch,
  ModelId,
  Run,
  RunOutcome,
  Session,
  SessionTitle,
  SkillSnapshot,
  type SessionSearchResult,
  StoredMessage,
  ToolCall,
  ToolOutcome,
  type StoreStatus,
} from "#src/schema";
import { searchSessions } from "#src/search";

interface StoreOperations {
  readonly status: Effect.Effect<StoreStatus, StoreError>;
  /** Creates a session with a fixed provider, model, and workload; optionally uses a supplied ID. */
  readonly createSession: (
    provider: ProviderId,
    model: string,
    options?: {
      readonly workload?: Session["workload"];
      readonly id?: string;
      readonly taskTitle?: string;
      readonly skill?: SkillSnapshot | null;
    },
  ) => Effect.Effect<Session, StoreError>;
  /** Manual metadata changes never reorder history; manual names win over in-flight generation. */
  readonly renameSession: (id: string, title: string) => Effect.Effect<Session, StoreError>;
  /** Claims at most one optional naming request after a successful exchange. */
  readonly claimTitle: (id: string) => Effect.Effect<Session | null, StoreError>;
  readonly finishTitle: (
    id: string,
    title: string | null,
    usage: Completion["usage"],
  ) => Effect.Effect<void, StoreError>;
  /** Returns null when the session does not exist. */
  readonly session: (id: string) => Effect.Effect<Session | null, StoreError>;
  readonly sessions: Effect.Effect<ReadonlyArray<Session>, StoreError>;
  /** Searches completed user/final-answer text within the caller's JSON byte budget. */
  readonly searchSessions: (
    query: string,
    maxBytes: number,
  ) => Effect.Effect<SessionSearchResult, StoreError>;
  /** Reads messages in session order and rejects continuation belonging to another model. */
  readonly messages: (sessionId: string) => Effect.Effect<ReadonlyArray<StoredMessage>, StoreError>;
  /** Appends the entire batch atomically; active sessions require their running run's ID. */
  readonly appendMessages: (batch: MessageBatch) => Effect.Effect<void, StoreError>;
  /** Saves a pending run and its inputs together; rejects any other pending or running run. */
  readonly queueRun: (
    sessionId: string,
    input: ReadonlyArray<ModelMessage>,
    id?: string,
    fallbackTitle?: string,
  ) => Effect.Effect<Run, StoreError>;
  /** Transitions a pending run to running; already-started or terminal runs are rejected. */
  readonly startRun: (id: string) => Effect.Effect<Run, StoreError>;
  /** Saves the terminal outcome and final answer together, settling any unfinished tools. */
  readonly finishRun: (id: string, outcome: RunOutcome) => Effect.Effect<Run, StoreError>;
  /** Returns null when absent and rejects provider or model state inconsistent with the session. */
  readonly run: (id: string) => Effect.Effect<Run | null, StoreError>;
  readonly runs: (sessionId: string) => Effect.Effect<ReadonlyArray<Run>, StoreError>;
  /** Saves a complete model tool request and its pending calls before execution begins. */
  readonly recordToolCalls: (
    runId: string,
    response: Completion,
  ) => Effect.Effect<ReadonlyArray<ToolCall>, StoreError>;
  /** Reads calls in execution order; the run must exist. */
  readonly toolCalls: (runId: string) => Effect.Effect<ReadonlyArray<ToolCall>, StoreError>;
  /** Marks a pending call as running before invoking the tool. */
  readonly startToolCall: (runId: string, callId: string) => Effect.Effect<void, StoreError>;
  /** Saves the outcome and, on success, appends the tool reply in the same transaction. */
  readonly finishToolCall: (
    runId: string,
    callId: string,
    outcome: ToolOutcome,
  ) => Effect.Effect<void, StoreError>;
}

/** Persists conversation history and tracks run and tool execution through terminal outcomes. */
export class Store extends Context.Service<Store, StoreOperations>()("poppet/Store") {}

const sessionSql = `SELECT id, provider, model, workload, created_at AS createdAt, updated_at AS updatedAt,
  title, title_source AS titleSource, title_attempted AS titleAttempted, title_usage AS titleUsage, skill FROM sessions`;

const SessionRecord = Schema.Struct({
  ...Session.fields,
  titleAttempted: Schema.BooleanFromBit,
  skill: Schema.NullOr(Schema.fromJsonString(SkillSnapshot)),
  titleUsage: Schema.NullOr(Schema.fromJsonString(Completion.fields.usage)),
});

const runSql = `SELECT id, session_id AS sessionId, provider, model, workload, status, created_at AS createdAt,
  started_at AS startedAt, finished_at AS finishedAt, result, failure_reason AS failureReason FROM runs`;

const messageSql = `SELECT id, session_id AS sessionId, run_id AS runId, position, created_at AS createdAt, payload AS message FROM messages`;

const toolSql = `SELECT run_id AS runId, call_id AS callId, position, name, namespace, arguments, status,
  created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt, output, failure_reason AS failureReason FROM tool_calls`;

const toolCallsFor = (database: Database, runId: string) =>
  readRecord(() => {
    using statement = database.prepare(`${toolSql} WHERE run_id = ? ORDER BY position`);

    return Schema.decodeUnknownSync(Schema.Array(ToolCall))(statement.all(runId));
  });

const activeTool = (database: Database, runId: string, callId: string) => {
  const run = requireRun(database, Schema.decodeUnknownSync(Id)(runId));
  const call = toolCallsFor(database, runId).find((entry) => entry.callId === callId);

  if (run.status !== "running" || !call || (call.status !== "pending" && call.status !== "running"))
    throw new StoreError({
      reason: "conflict",
      message: "The tool call must belong to the running run and be active.",
    });

  return { run, call };
};

const interruptTools = (database: Database, runId: string, at: number, reason: string) => {
  // Finalize this update before later run transitions and database shutdown.
  using statement =
    database.prepare(`UPDATE tool_calls SET status = CASE WHEN status = 'running' THEN 'uncertain' ELSE 'interrupted' END,
    finished_at = MAX(created_at, COALESCE(started_at, 0), ?), failure_reason = ?
    WHERE run_id = ? AND status IN ('pending', 'running')`);

  statement.run(at, reason, runId);
};

const RunRecord = Schema.Struct({
  ...Run.fields,
  result: Schema.NullOr(Schema.fromJsonString(Completion)),
});

const MessageRecord = Schema.Struct({
  ...StoredMessage.fields,
  message: Schema.fromJsonString(Message),
});

const Counts = Schema.Struct({
  sessions: Schema.Natural,
  messages: Schema.Natural,
  runs: Schema.Natural,
});

const Position = Schema.Struct({ position: Schema.Natural });

const continuationMatches = (
  selection: Pick<Session, "provider" | "model">,
  continuation: Continuation,
) => continuation.provider === selection.provider && continuation.model === selection.model;

const requestFailure = (cause: unknown) =>
  cause instanceof Schema.SchemaError
    ? new StoreError({
        reason: "invalid-request",
        message: "The conversation store request is invalid.",
      })
    : storageFailure(cause);

const sessionFor = (database: Database, id: string) =>
  readRecord(() =>
    Schema.decodeUnknownSync(Schema.NullOr(SessionRecord))(
      database.query(`${sessionSql} WHERE id = ?`).get(id),
    ),
  );

// Decoding a row alone cannot check whether its model identity agrees with the session and result.
const validateRunRecord = (session: Session | null, run: Run) => {
  if (
    !session ||
    run.sessionId !== session.id ||
    run.provider !== session.provider ||
    run.model !== session.model ||
    run.workload !== session.workload ||
    (run.result !== null && !continuationMatches(run, run.result.continuation))
  )
    throw corruptRecord();

  return run;
};

const runFor = (database: Database, id: string) =>
  readRecord(() => {
    const run = Schema.decodeUnknownSync(Schema.NullOr(RunRecord))(
      database.query(`${runSql} WHERE id = ?`).get(id),
    );

    return run === null ? null : validateRunRecord(sessionFor(database, run.sessionId), run);
  });

const requireSession = (database: Database, id: string) => {
  const session = sessionFor(database, id);

  if (!session)
    throw new StoreError({ reason: "not-found", message: "The session does not exist." });

  return session;
};

const requireRun = (database: Database, id: string) => {
  const run = runFor(database, id);

  if (!run) throw new StoreError({ reason: "not-found", message: "The run does not exist." });

  return run;
};

const validateContinuation = (session: Session, messages: ReadonlyArray<ModelMessage>) => {
  for (const message of messages) {
    if (
      message.role === "assistant" &&
      message.continuation !== null &&
      !continuationMatches(session, message.continuation)
    )
      throw new StoreError({
        reason: "invalid-request",
        message: "Continuation belongs to another provider or model. Start a new session.",
      });
  }
};

const append = (
  database: Database,
  session: Session,
  runId: string | null,
  messages: ReadonlyArray<ModelMessage>,
  at: number,
) => {
  validateContinuation(session, messages);

  let position = readRecord(() =>
    Schema.decodeUnknownSync(Position)(
      database
        .query(
          "SELECT COALESCE(MAX(position) + 1, 0) AS position FROM messages WHERE session_id = ?",
        )
        .get(session.id),
    ),
  ).position;

  const insert = database.query(
    "INSERT INTO messages (session_id, run_id, position, created_at, payload) VALUES (?, ?, ?, ?, ?)",
  );

  for (const message of messages) {
    insert.run(
      session.id,
      runId,
      position++,
      at,
      Schema.encodeSync(Schema.fromJsonString(Message))(message),
    );
  }

  database
    .query("UPDATE sessions SET updated_at = MAX(updated_at, ?) WHERE id = ?")
    .run(at, session.id);
};

const atTime = <A>(operation: (at: number) => A) =>
  DateTime.nowAsDate.pipe(
    Effect.flatMap((date) =>
      Effect.try({ try: () => operation(date.getTime()), catch: requestFailure }),
    ),
  );

export const StoreLive = Layer.effect(
  Store,
  Effect.gen(function* () {
    const { database, path, schemaVersion } = yield* StoreDatabase;

    // A previous owner may have crashed between durable queueing and completion.
    // Preserve its inputs, but never automatically replay work with uncertain effects.
    yield* atTime((at) =>
      database
        .transaction(() => {
          for (const run of Schema.decodeUnknownSync(Schema.Array(RunRecord))(
            database.query(`${runSql} WHERE status IN ('pending', 'running')`).all(),
          ))
            interruptTools(database, run.id, at, "process-exit");
          database
            .query(
              `UPDATE runs SET status = 'interrupted', finished_at = MAX(created_at, COALESCE(started_at, 0), ?), failure_reason = 'process-exit' WHERE status IN ('pending', 'running')`,
            )
            .run(at);
        })
        .immediate(),
    );

    const createSession: StoreOperations["createSession"] = (
      provider,
      model,
      { workload = "assistant", id: suppliedId, taskTitle, skill = null } = {},
    ) =>
      atTime((at) => {
        const selectedProvider = Schema.decodeUnknownSync(ProviderId)(provider);
        const selectedModel = Schema.decodeUnknownSync(ModelId)(model);
        const selectedWorkload = Schema.decodeUnknownSync(Session.fields.workload)(workload);
        const id = Schema.decodeUnknownSync(Id)(suppliedId ?? randomUUID());

        const title =
          taskTitle === undefined
            ? "New conversation"
            : Schema.decodeUnknownSync(SessionTitle)(taskTitle);

        database
          .query(`INSERT INTO sessions (id, provider, model, created_at, updated_at, workload, title, title_source, title_attempted, skill)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            id,
            selectedProvider,
            selectedModel,
            at,
            at,
            selectedWorkload,
            title,
            taskTitle === undefined ? "fallback" : "task",
            taskTitle === undefined ? 0 : 1,
            skill === null ? null : Schema.encodeSync(Schema.fromJsonString(SkillSnapshot))(skill),
          );

        return requireSession(database, id);
      });

    const queueRun = (
      sessionId: string,
      input: ReadonlyArray<ModelMessage>,
      suppliedId?: string,
      fallbackTitle?: string,
    ) =>
      atTime((at) =>
        database
          .transaction(() => {
            const id = Schema.decodeUnknownSync(Id)(sessionId);

            const messages = Schema.decodeUnknownSync(Schema.Array(Message), {
              onExcessProperty: "error",
            })(input);

            const session = requireSession(database, id);

            if (database.query("SELECT id FROM runs WHERE status IN ('pending', 'running')").get())
              throw new StoreError({
                reason: "conflict",
                message: "Another run is pending or running.",
              });
            const runId = Schema.decodeUnknownSync(Id)(suppliedId ?? randomUUID());
            const createdAt = Math.max(at, session.createdAt);
            database
              .query(
                `INSERT INTO runs (id, session_id, provider, model, workload, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
              )
              .run(runId, id, session.provider, session.model, session.workload, createdAt);

            if (fallbackTitle !== undefined)
              database
                .query(`UPDATE sessions SET title = ?, title_source = 'fallback'
                WHERE id = ? AND title_source = 'fallback' AND NOT EXISTS (SELECT 1 FROM messages WHERE session_id = ?)`)
                .run(Schema.decodeUnknownSync(SessionTitle)(fallbackTitle), id, id);
            append(database, session, runId, messages, createdAt);

            return requireRun(database, runId);
          })
          .immediate(),
      );

    const startRun = (id: string) =>
      atTime((at) =>
        database
          .transaction(() => {
            const run = requireRun(database, Schema.decodeUnknownSync(Id)(id));

            if (run.status !== "pending")
              throw new StoreError({
                reason: "conflict",
                message: "Only a pending run can be started.",
              });
            database
              .query("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?")
              .run(Math.max(at, run.createdAt), id);

            return requireRun(database, id);
          })
          .immediate(),
      );

    const finishRun = (id: string, outcome: RunOutcome) =>
      atTime((at) =>
        database
          .transaction(() => {
            const run = requireRun(database, Schema.decodeUnknownSync(Id)(id));

            const terminal = Schema.decodeUnknownSync(RunOutcome, { onExcessProperty: "error" })(
              outcome,
            );

            if (
              run.status !== "running" &&
              !(run.status === "pending" && terminal.status !== "completed")
            )
              throw new StoreError({
                reason: "conflict",
                message: "Only an active run can be finished; completion requires a running run.",
              });
            const finishedAt = Math.max(at, run.createdAt, run.startedAt ?? 0);

            if (terminal.status === "completed") {
              if (toolCallsFor(database, id).some((call) => call.status !== "completed"))
                throw new StoreError({
                  reason: "conflict",
                  message: "All tool calls must complete before the run succeeds.",
                });
              append(
                database,
                requireSession(database, run.sessionId),
                id,
                [
                  {
                    role: "assistant",
                    output: terminal.response.output,
                    continuation: terminal.response.continuation,
                  },
                ],
                finishedAt,
              );
              database
                .query(
                  "UPDATE runs SET status = 'completed', finished_at = ?, result = ? WHERE id = ?",
                )
                .run(
                  finishedAt,
                  Schema.encodeSync(Schema.fromJsonString(Completion))(terminal.response),
                  id,
                );
            } else {
              interruptTools(database, id, finishedAt, terminal.reason);
              database
                .query(
                  "UPDATE runs SET status = ?, finished_at = ?, failure_reason = ? WHERE id = ?",
                )
                .run(terminal.status, finishedAt, terminal.reason, id);
              database
                .query("UPDATE sessions SET updated_at = MAX(updated_at, ?) WHERE id = ?")
                .run(finishedAt, run.sessionId);
            }

            return requireRun(database, id);
          })
          .immediate(),
      );

    const appendMessages = (batch: MessageBatch) =>
      atTime((at) =>
        database
          .transaction(() => {
            const decoded = Schema.decodeUnknownSync(MessageBatch, { onExcessProperty: "error" })(
              batch,
            );

            const session = requireSession(database, decoded.sessionId);

            if (decoded.runId !== null) {
              const run = requireRun(database, decoded.runId);

              if (run.sessionId !== session.id || run.status !== "running")
                throw new StoreError({
                  reason: "conflict",
                  message: "Messages must belong to a running run in this session.",
                });
            } else if (
              database
                .query(
                  "SELECT id FROM runs WHERE session_id = ? AND status IN ('pending', 'running')",
                )
                .get(session.id)
            )
              throw new StoreError({
                reason: "conflict",
                message: "Append messages through the active run.",
              });
            append(
              database,
              session,
              decoded.runId,
              decoded.messages,
              Math.max(at, session.createdAt),
            );
          })
          .immediate(),
      );

    const recordToolCalls = (runId: string, response: Completion) =>
      atTime((at) =>
        database
          .transaction(() => {
            const run = requireRun(database, Schema.decodeUnknownSync(Id)(runId));

            const decoded = Schema.decodeUnknownSync(Completion, { onExcessProperty: "error" })(
              response,
            );

            const calls = decoded.output.flatMap((part) =>
              part.type === "tool-call" ? [part] : [],
            );

            if (
              run.status !== "running" ||
              decoded.finishReason !== "tool-calls" ||
              calls.length === 0
            )
              throw new StoreError({
                reason: "conflict",
                message: "Only completed tool requests in a running run can be recorded.",
              });
            const position = toolCallsFor(database, runId).length;
            const createdAt = Math.max(at, run.startedAt ?? run.createdAt);

            using existing = database.prepare(
              "SELECT call_id FROM tool_calls WHERE run_id = ? AND call_id = ?",
            );

            using insert =
              database.prepare(`INSERT INTO tool_calls (run_id, call_id, position, name, namespace, arguments, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`);

            for (const [index, call] of calls.entries()) {
              if (existing.get(runId, call.callId))
                throw new StoreError({
                  reason: "conflict",
                  message: "Tool call IDs cannot be reused within a run.",
                });
              insert.run(
                runId,
                call.callId,
                position + index,
                call.name,
                call.namespace,
                call.arguments,
                createdAt,
              );
            }

            append(
              database,
              requireSession(database, run.sessionId),
              runId,
              [{ role: "assistant", output: decoded.output, continuation: decoded.continuation }],
              createdAt,
            );

            return toolCallsFor(database, runId).slice(position);
          })
          .immediate(),
      );

    const startToolCall = (runId: string, callId: string) =>
      atTime((at) =>
        database
          .transaction(() => {
            const { call } = activeTool(database, runId, callId);

            if (call.status !== "pending")
              throw new StoreError({
                reason: "conflict",
                message: "The tool call has already started.",
              });

            using statement = database.prepare(
              "UPDATE tool_calls SET status = 'running', started_at = ? WHERE run_id = ? AND call_id = ?",
            );

            statement.run(Math.max(at, call.createdAt), runId, callId);
          })
          .immediate(),
      );

    const finishToolCall = (runId: string, callId: string, outcome: ToolOutcome) =>
      atTime((at) =>
        database
          .transaction(() => {
            const { run, call } = activeTool(database, runId, callId);

            const decoded = Schema.decodeUnknownSync(ToolOutcome, { onExcessProperty: "error" })(
              outcome,
            );

            const finishedAt = Math.max(at, call.startedAt ?? call.createdAt);

            if (decoded.status === "completed") {
              if (call.status !== "running")
                throw new StoreError({
                  reason: "conflict",
                  message: "Only a started tool call can complete.",
                });
              append(
                database,
                requireSession(database, run.sessionId),
                runId,
                [{ role: "tool", callId, output: decoded.output }],
                finishedAt,
              );
            }

            using statement = database.prepare(
              "UPDATE tool_calls SET status = ?, finished_at = ?, output = ?, failure_reason = ? WHERE run_id = ? AND call_id = ?",
            );

            statement.run(
              decoded.status,
              finishedAt,
              decoded.status === "completed" ? decoded.output : null,
              decoded.status === "completed" ? null : decoded.reason,
              runId,
              callId,
            );
          })
          .immediate(),
      );

    return {
      recordToolCalls,
      startToolCall,
      finishToolCall,
      toolCalls: (runId) =>
        atTime(() => {
          requireRun(database, Schema.decodeUnknownSync(Id)(runId));

          return toolCallsFor(database, runId);
        }),
      renameSession: (id, title) =>
        atTime(() => {
          requireSession(database, Schema.decodeUnknownSync(Id)(id));
          database
            .query("UPDATE sessions SET title = ?, title_source = 'manual' WHERE id = ?")
            .run(Schema.decodeUnknownSync(SessionTitle)(title), id);

          return requireSession(database, id);
        }),
      claimTitle: (id) =>
        atTime(() =>
          database
            .transaction(() => {
              requireSession(database, Schema.decodeUnknownSync(Id)(id));

              const changed = database
                .query(`UPDATE sessions SET title_attempted = 1 WHERE id = ?
          AND title_source = 'fallback' AND title_attempted = 0
          AND EXISTS (SELECT 1 FROM runs WHERE session_id = ? AND status = 'completed')`)
                .run(id, id);

              return changed.changes === 1 ? requireSession(database, id) : null;
            })
            .immediate(),
        ),
      finishTitle: (id, title, usage) =>
        atTime(() => {
          requireSession(database, Schema.decodeUnknownSync(Id)(id));
          const decoded = title === null ? null : Schema.decodeUnknownSync(SessionTitle)(title);

          const savedUsage =
            usage === null
              ? null
              : Schema.encodeSync(Schema.fromJsonString(Completion.fields.usage))(usage);

          database
            .query(`UPDATE sessions SET title_usage = ?,
          title = CASE WHEN title_source = 'fallback' AND ? IS NOT NULL THEN ? ELSE title END,
          title_source = CASE WHEN title_source = 'fallback' AND ? IS NOT NULL THEN 'generated' ELSE title_source END
          WHERE id = ? AND title_attempted = 1`)
            .run(savedUsage, decoded, decoded, decoded, id);
        }),
      createSession,
      queueRun,
      startRun,
      finishRun,
      appendMessages,
      searchSessions: (query, maxBytes) =>
        Effect.try({ try: () => searchSessions(database, query, maxBytes), catch: requestFailure }),
      session: (id) =>
        Effect.try({
          try: () => sessionFor(database, Schema.decodeUnknownSync(Id)(id)),
          catch: requestFailure,
        }),
      sessions: Effect.try({
        try: () =>
          readRecord(() =>
            Schema.decodeUnknownSync(Schema.Array(SessionRecord))(
              database.query(`${sessionSql} ORDER BY created_at, id`).all(),
            ),
          ),
        catch: storageFailure,
      }),
      messages: (sessionId) =>
        Effect.try({
          try: () => {
            const session = requireSession(database, Schema.decodeUnknownSync(Id)(sessionId));

            const messages = readRecord(() =>
              Schema.decodeUnknownSync(Schema.Array(MessageRecord))(
                database
                  .query(`${messageSql} WHERE session_id = ? ORDER BY position`)
                  .all(sessionId),
              ),
            );

            for (const entry of messages) {
              if (
                entry.message.role === "assistant" &&
                entry.message.continuation !== null &&
                !continuationMatches(session, entry.message.continuation)
              )
                throw corruptRecord();
            }

            return messages;
          },
          catch: requestFailure,
        }),
      run: (id) =>
        Effect.try({
          try: () => runFor(database, Schema.decodeUnknownSync(Id)(id)),
          catch: requestFailure,
        }),
      runs: (sessionId) =>
        Effect.try({
          try: () => {
            const session = requireSession(database, Schema.decodeUnknownSync(Id)(sessionId));

            const runs = readRecord(() =>
              Schema.decodeUnknownSync(Schema.Array(RunRecord))(
                database
                  .query(`${runSql} WHERE session_id = ? ORDER BY created_at, id`)
                  .all(sessionId),
              ),
            );

            return runs.map((run) => validateRunRecord(session, run));
          },
          catch: requestFailure,
        }),
      status: Effect.try({
        try: () => ({
          path,
          schemaVersion,
          ...readRecord(() =>
            Schema.decodeUnknownSync(Counts)(
              database
                .query(
                  "SELECT (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM runs) AS runs",
                )
                .get(),
            ),
          ),
        }),
        catch: storageFailure,
      }),
    } satisfies StoreOperations;
  }),
).pipe(Layer.provideMerge(StoreDatabaseLive));
