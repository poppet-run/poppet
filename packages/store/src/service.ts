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
import { StoreError, storageFailure } from "#src/errors";
import {
  Id,
  MessageBatch,
  ModelId,
  MemoryFact,
  Run,
  RunOutcome,
  Session,
  StoredMessage,
  ToolCall,
  ToolOutcome,
  type StoreStatus,
} from "#src/schema";

interface StoreOperations {
  readonly memories: Effect.Effect<ReadonlyArray<MemoryFact>, StoreError>;
  readonly rememberMemory: (
    key: string,
    value: string,
    sourceRunId?: string | null,
  ) => Effect.Effect<MemoryFact, StoreError>;
  readonly replaceMemory: (
    key: string,
    value: string,
    sourceRunId?: string | null,
  ) => Effect.Effect<MemoryFact, StoreError>;
  readonly forgetMemory: (key: string) => Effect.Effect<void, StoreError>;
  readonly status: Effect.Effect<StoreStatus, StoreError>;
  readonly createSession: (
    provider: ProviderId,
    model: string,
    workload?: Session["workload"],
  ) => Effect.Effect<Session, StoreError>;
  readonly session: (id: string) => Effect.Effect<Session | null, StoreError>;
  readonly sessions: Effect.Effect<ReadonlyArray<Session>, StoreError>;
  readonly messages: (sessionId: string) => Effect.Effect<ReadonlyArray<StoredMessage>, StoreError>;
  readonly appendMessages: (batch: MessageBatch) => Effect.Effect<void, StoreError>;
  readonly queueRun: (
    sessionId: string,
    input: ReadonlyArray<ModelMessage>,
  ) => Effect.Effect<Run, StoreError>;
  readonly startRun: (id: string) => Effect.Effect<Run, StoreError>;
  readonly finishRun: (id: string, outcome: RunOutcome) => Effect.Effect<Run, StoreError>;
  readonly run: (id: string) => Effect.Effect<Run | null, StoreError>;
  readonly runs: (sessionId: string) => Effect.Effect<ReadonlyArray<Run>, StoreError>;
  readonly recordToolCalls: (
    runId: string,
    response: Completion,
  ) => Effect.Effect<ReadonlyArray<ToolCall>, StoreError>;
  readonly toolCalls: (runId: string) => Effect.Effect<ReadonlyArray<ToolCall>, StoreError>;
  readonly startToolCall: (runId: string, callId: string) => Effect.Effect<void, StoreError>;
  readonly finishToolCall: (
    runId: string,
    callId: string,
    outcome: ToolOutcome,
  ) => Effect.Effect<void, StoreError>;
}

export class Store extends Context.Service<Store, StoreOperations>()("poppet/Store") {}

const sessionSql = `SELECT id, provider, model, workload, created_at AS createdAt, updated_at AS updatedAt FROM sessions`;

const runSql = `SELECT id, session_id AS sessionId, provider, model, workload, status, created_at AS createdAt,
  started_at AS startedAt, finished_at AS finishedAt, result, failure_reason AS failureReason FROM runs`;

const messageSql = `SELECT id, session_id AS sessionId, run_id AS runId, position, created_at AS createdAt, payload AS message FROM messages`;

const memorySql = `SELECT key, value, source_run_id AS sourceRunId, updated_at AS updatedAt FROM memories`;

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

const corruptRecord = () =>
  new StoreError({
    reason: "corrupt",
    message: "The conversation store contains an invalid record.",
  });

const continuationMatches = (
  selection: Pick<Session, "provider" | "model">,
  continuation: Continuation,
) => continuation.provider === selection.provider && continuation.model === selection.model;

const readRecord = <A>(read: () => A): A => {
  try {
    return read();
  } catch (cause) {
    if (cause instanceof Schema.SchemaError) throw corruptRecord();
    throw cause;
  }
};

const requestFailure = (cause: unknown) =>
  cause instanceof Schema.SchemaError
    ? new StoreError({
        reason: "invalid-request",
        message: "The conversation store request is invalid.",
      })
    : storageFailure(cause);

const sessionFor = (database: Database, id: string) =>
  readRecord(() =>
    Schema.decodeUnknownSync(Schema.NullOr(Session))(
      database.query(`${sessionSql} WHERE id = ?`).get(id),
    ),
  );

const validateRunRecord = (database: Database, run: Run) => {
  const session = sessionFor(database, run.sessionId);

  if (
    !session ||
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

    return run === null ? null : validateRunRecord(database, run);
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

    const createSession = (
      provider: ProviderId,
      model: string,
      workload: Session["workload"] = "assistant",
    ) =>
      atTime((at) => {
        const selectedProvider = Schema.decodeUnknownSync(ProviderId)(provider);
        const selectedModel = Schema.decodeUnknownSync(ModelId)(model);
        const selectedWorkload = Schema.decodeUnknownSync(Session.fields.workload)(workload);
        const id = randomUUID();
        database
          .query(
            "INSERT INTO sessions (id, provider, model, created_at, updated_at, workload) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(id, selectedProvider, selectedModel, at, at, selectedWorkload);

        return requireSession(database, id);
      });

    const queueRun = (sessionId: string, input: ReadonlyArray<ModelMessage>) =>
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
            const runId = randomUUID();
            const createdAt = Math.max(at, session.createdAt);
            database
              .query(
                `INSERT INTO runs (id, session_id, provider, model, workload, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
              )
              .run(runId, id, session.provider, session.model, session.workload, createdAt);
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

    const saveMemory = (
      key: string,
      value: string,
      sourceRunId: string | null,
      mode: "remember" | "replace",
    ) =>
      atTime((at) =>
        database
          .transaction(() => {
            const input = Schema.decodeUnknownSync(MemoryFact, { onExcessProperty: "error" })({
              key,
              value,
              sourceRunId,
              updatedAt: at,
            });

            if (sourceRunId !== null) requireRun(database, sourceRunId);
            using select = database.prepare(`${memorySql} WHERE key = ?`);

            const existing = readRecord(() =>
              Schema.decodeUnknownSync(Schema.NullOr(MemoryFact))(select.get(key)),
            );

            if (mode === "replace" && existing === null)
              throw new StoreError({
                reason: "not-found",
                message: "The fact does not exist. Use memory remember to create it.",
              });

            if (mode === "remember" && existing !== null)
              throw new StoreError({
                reason: "conflict",
                message: "The fact already exists. Use memory replace to change it.",
              });

            if (mode === "remember") {
              using count = database.prepare("SELECT COUNT(*) AS count FROM memories");

              const total = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Natural }))(
                count.get(),
              ).count;

              if (total >= 128)
                throw new StoreError({
                  reason: "conflict",
                  message: "Memory holds at most 128 facts. Forget a fact before adding another.",
                });
            }

            const fact = { ...input, updatedAt: Math.max(at, existing?.updatedAt ?? 0) };

            using write = database.prepare(
              mode === "replace"
                ? "UPDATE memories SET value = ?, source_run_id = ?, updated_at = ? WHERE key = ?"
                : "INSERT INTO memories (value, source_run_id, updated_at, key) VALUES (?, ?, ?, ?)",
            );

            write.run(fact.value, fact.sourceRunId, fact.updatedAt, fact.key);

            return fact;
          })
          .immediate(),
      );

    return {
      memories: atTime(() =>
        readRecord(() => {
          using statement = database.prepare(`${memorySql} ORDER BY key`);

          return Schema.decodeUnknownSync(Schema.Array(MemoryFact))(statement.all());
        }),
      ),
      rememberMemory: (key, value, sourceRunId = null) =>
        saveMemory(key, value, sourceRunId, "remember"),
      replaceMemory: (key, value, sourceRunId = null) =>
        saveMemory(key, value, sourceRunId, "replace"),
      forgetMemory: (key) =>
        atTime(() => {
          Schema.decodeUnknownSync(MemoryFact.fields.key)(key);
          using statement = database.prepare("DELETE FROM memories WHERE key = ?");

          if (statement.run(key).changes === 0)
            throw new StoreError({ reason: "not-found", message: "The fact does not exist." });
        }),
      recordToolCalls,
      startToolCall,
      finishToolCall,
      toolCalls: (runId) =>
        atTime(() => {
          requireRun(database, Schema.decodeUnknownSync(Id)(runId));

          return toolCallsFor(database, runId);
        }),
      createSession,
      queueRun,
      startRun,
      finishRun,
      appendMessages,
      session: (id) =>
        Effect.try({
          try: () => sessionFor(database, Schema.decodeUnknownSync(Id)(id)),
          catch: requestFailure,
        }),
      sessions: Effect.try({
        try: () =>
          readRecord(() =>
            Schema.decodeUnknownSync(Schema.Array(Session))(
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
            requireSession(database, Schema.decodeUnknownSync(Id)(sessionId));

            const runs = readRecord(() =>
              Schema.decodeUnknownSync(Schema.Array(RunRecord))(
                database
                  .query(`${runSql} WHERE session_id = ? ORDER BY created_at, id`)
                  .all(sessionId),
              ),
            );

            return runs.map((run) => validateRunRecord(database, run));
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
).pipe(Layer.provide(StoreDatabaseLive));
