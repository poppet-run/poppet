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
  Run,
  RunOutcome,
  Session,
  StoredMessage,
  type StoreStatus,
} from "#src/schema";

interface StoreOperations {
  readonly status: Effect.Effect<StoreStatus, StoreError>;
  readonly createSession: (
    provider: ProviderId,
    model: string,
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
}

export class Store extends Context.Service<Store, StoreOperations>()("poppet/Store") {}

const sessionSql = `SELECT id, provider, model, created_at AS createdAt, updated_at AS updatedAt FROM sessions`;

const runSql = `SELECT id, session_id AS sessionId, provider, model, status, created_at AS createdAt,
  started_at AS startedAt, finished_at AS finishedAt, result, failure_reason AS failureReason FROM runs`;

const messageSql = `SELECT id, session_id AS sessionId, run_id AS runId, position, created_at AS createdAt, payload AS message FROM messages`;

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
        .query(
          `UPDATE runs SET status = 'interrupted', finished_at = MAX(created_at, COALESCE(started_at, 0), ?), failure_reason = 'process-exit' WHERE status IN ('pending', 'running')`,
        )
        .run(at),
    );

    const createSession = (provider: ProviderId, model: string) =>
      atTime((at) => {
        const selectedProvider = Schema.decodeUnknownSync(ProviderId)(provider);
        const selectedModel = Schema.decodeUnknownSync(ModelId)(model);
        const id = randomUUID();
        database
          .query("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)")
          .run(id, selectedProvider, selectedModel, at, at);

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
                `INSERT INTO runs (id, session_id, provider, model, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
              )
              .run(runId, id, session.provider, session.model, createdAt);
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

            if (run.status !== "running")
              throw new StoreError({
                reason: "conflict",
                message: "Only a running run can be finished.",
              });
            const finishedAt = Math.max(at, run.createdAt, run.startedAt ?? 0);

            if (terminal.status === "completed") {
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

    return {
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
