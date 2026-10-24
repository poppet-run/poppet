import { randomUUID } from "node:crypto";

import {
  Completion,
  Message,
  ProviderId,
  type Continuation,
  type Message as ModelMessage,
} from "@poppet/provider";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { StoreDatabase, StoreDatabaseLive } from "#src/database";
import {
  StoreError,
  decodeInput,
  logStorageCause,
  reportAs,
  storageFailure,
  storeFailure,
} from "#src/errors";
import { storeSchema } from "#src/migrations";
import { readSession } from "#src/recall";
import {
  Id,
  ModelId,
  Run,
  RunOutcome,
  Session,
  SessionTitle,
  SkillSnapshot,
  type SessionSearchResult,
  type SessionReadQuery,
  type SessionReadResult,
  StoredMessage,
  ToolCall,
  ToolOutcome,
  type StoreStatus,
} from "#src/schema";
import { searchSessions } from "#src/search";
import { decodeRow, decodeRows } from "#src/sql";

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
  readonly searchSessions: (
    query: string,
    maxBytes: number,
  ) => Effect.Effect<SessionSearchResult, StoreError>;
  /** Reads at most ten eligible messages around or after a stable anchor within a JSON byte budget. */
  readonly readSession: (
    query: SessionReadQuery,
    maxBytes: number,
  ) => Effect.Effect<SessionReadResult, StoreError>;
  /** Reads messages in session order. */
  readonly messages: (sessionId: string) => Effect.Effect<ReadonlyArray<StoredMessage>, StoreError>;
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
  /** Returns null when the run does not exist. */
  readonly run: (id: string) => Effect.Effect<Run | null, StoreError>;
  readonly runs: (sessionId: string) => Effect.Effect<ReadonlyArray<Run>, StoreError>;
  /** Saves a complete model tool request and its pending calls before execution begins. */
  readonly recordToolCalls: (
    runId: string,
    response: Completion,
    identities?: ReadonlyArray<{
      readonly callId: string;
      readonly serverId: string;
      readonly toolName: string;
    }>,
  ) => Effect.Effect<ReadonlyArray<ToolCall>, StoreError>;
  /** Reads calls in execution order; the run must exist. */
  readonly toolCalls: (runId: string) => Effect.Effect<ReadonlyArray<ToolCall>, StoreError>;
  /** Marks a pending call as running before invoking the tool. */
  readonly startToolCall: (runId: string, callId: string) => Effect.Effect<void, StoreError>;
  /** Saves the outcome and any reply, including reported failures, in the same transaction. */
  readonly finishToolCall: (
    runId: string,
    callId: string,
    outcome: ToolOutcome,
  ) => Effect.Effect<void, StoreError>;
  /**
   * Runs a local database change and saves its receipt in one transaction.
   * A call that already completed returns its saved receipt without running the change again.
   */
  readonly commitToolCall: <E, R>(
    runId: string,
    callId: string,
    operation: Effect.Effect<string, E, R>,
  ) => Effect.Effect<string, StoreError | E, R>;
}

/** Persists conversation history and tracks run and tool execution through terminal outcomes. */
export class Store extends Context.Service<Store, StoreOperations>()("poppet/Store") {}

const SessionRow = Schema.Struct({
  ...Session.fields,
  titleAttempted: Schema.BooleanFromBit,
  skill: Schema.NullOr(Schema.fromJsonString(SkillSnapshot)),
  titleUsage: Schema.NullOr(Schema.fromJsonString(Completion.fields.usage)),
});

const RunRow = Schema.Struct({
  ...Run.fields,
  result: Schema.NullOr(Schema.fromJsonString(Completion)),
});

const MessageRow = Schema.Struct({
  ...StoredMessage.fields,
  message: Schema.fromJsonString(Message),
});

const encodeMessage = Schema.encodeSync(Schema.fromJsonString(Message));

const conflict = (message: string) => new StoreError({ reason: "conflict", message });

const notFound = (message: string) => new StoreError({ reason: "not-found", message });

const continuationMatches = (session: Session, continuation: Continuation) =>
  continuation.provider === session.provider && continuation.model === session.model;

export const StoreLive = Layer.effect(
  Store,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { path } = yield* StoreDatabase;

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

    // A run's provider, model, and workload are its session's.
    const runs = sql`SELECT runs.*, sessions.provider, sessions.model, sessions.workload
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

    // A previous owner may have crashed between durable queueing and completion.
    // Preserve its inputs, but never automatically replay work with uncertain effects.
    yield* transaction(
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;

        yield* sql`UPDATE tool_calls
          SET status = CASE WHEN status = 'running' THEN 'uncertain' ELSE 'interrupted' END,
            finished_at = MAX(created_at, COALESCE(started_at, 0), ${at}),
            failure_reason = 'process-exit'
          WHERE status IN ('pending', 'running')`;

        yield* sql`UPDATE runs SET status = 'interrupted',
            finished_at = MAX(created_at, COALESCE(started_at, 0), ${at}),
            failure_reason = 'process-exit'
          WHERE status IN ('pending', 'running')`;
      }),
    );

    const createSession: StoreOperations["createSession"] = (
      provider,
      model,
      { workload = "assistant", id = randomUUID(), taskTitle, skill = null } = {},
    ) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;

        const title =
          taskTitle === undefined
            ? "New conversation"
            : yield* decodeInput(SessionTitle, taskTitle);

        yield* sql`INSERT INTO sessions ${sql.insert({
          id: yield* decodeInput(Id, id),
          provider: yield* decodeInput(ProviderId, provider),
          model: yield* decodeInput(ModelId, model),
          workload: yield* decodeInput(Session.fields.workload, workload),
          createdAt: at,
          updatedAt: at,
          title,
          titleSource: taskTitle === undefined ? "fallback" : "task",
          titleAttempted: taskTitle === undefined ? 0 : 1,
          skill: skill === null ? null : JSON.stringify(yield* decodeInput(SkillSnapshot, skill)),
        })}`;

        return yield* requireSession(id);
      }).pipe(reportAs(storeFailure));

    const queueRun: StoreOperations["queueRun"] = (
      sessionId,
      input,
      runId = randomUUID(),
      fallbackTitle,
    ) =>
      transaction(
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;

          const messages = yield* decodeInput(Schema.Array(Message), input, {
            onExcessProperty: "error",
          });

          const session = yield* requireSession(yield* decodeInput(Id, sessionId));

          const active = yield* sql`SELECT id FROM runs WHERE status IN ('pending', 'running')`;

          if (active.length > 0) return yield* conflict("Another run is pending or running.");

          const createdAt = Math.max(at, session.createdAt);

          yield* sql`INSERT INTO runs ${sql.insert({
            id: yield* decodeInput(Id, runId),
            sessionId,
            status: "pending",
            createdAt,
          })}`;

          // The first message names a session until a generated or manual title replaces it.
          if (fallbackTitle !== undefined) {
            const title = yield* decodeInput(SessionTitle, fallbackTitle);

            yield* sql`UPDATE sessions SET title = ${title}, title_source = 'fallback'
              WHERE id = ${sessionId} AND title_source = 'fallback'
                AND NOT EXISTS (SELECT 1 FROM messages WHERE session_id = ${sessionId})`;
          }

          yield* append(session, runId, messages, createdAt);

          return yield* requireRun(runId);
        }),
      );

    const startRun: StoreOperations["startRun"] = (id) =>
      transaction(
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          const run = yield* requireRun(yield* decodeInput(Id, id));

          if (run.status !== "pending")
            return yield* conflict("Only a pending run can be started.");

          yield* sql`UPDATE runs SET status = 'running', started_at = ${Math.max(at, run.createdAt)}
            WHERE id = ${id}`;

          return yield* requireRun(id);
        }),
      );

    const finishRun: StoreOperations["finishRun"] = (id, outcome) =>
      transaction(
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          const run = yield* requireRun(yield* decodeInput(Id, id));
          const terminal = yield* decodeInput(RunOutcome, outcome, { onExcessProperty: "error" });

          if (
            run.status !== "running" &&
            !(run.status === "pending" && terminal.status !== "completed")
          )
            return yield* conflict(
              "Only an active run can be finished; completion requires a running run.",
            );

          const finishedAt = Math.max(at, run.createdAt, run.startedAt ?? 0);

          if (terminal.status !== "completed") {
            yield* interruptTools(id, finishedAt, terminal.reason);
            yield* sql`UPDATE runs SET status = ${terminal.status}, finished_at = ${finishedAt},
              failure_reason = ${terminal.reason} WHERE id = ${id}`;
            yield* touch(run.sessionId, finishedAt);

            return yield* requireRun(id);
          }

          const replied = yield* repliedCalls(id);

          // A failed call may still complete its run when the model received the failure as a reply.
          if (
            (yield* toolCallsFor(id)).some(
              (call) =>
                call.status !== "completed" &&
                !(call.status === "failed" && replied.has(call.callId)),
            )
          )
            return yield* conflict(
              "All tool calls must complete or report their failure before the run succeeds.",
            );

          const { output, continuation } = terminal.response;

          yield* append(
            yield* requireSession(run.sessionId),
            id,
            [{ role: "assistant", output, continuation }],
            finishedAt,
          );

          yield* sql`UPDATE runs SET status = 'completed', finished_at = ${finishedAt},
            result = ${JSON.stringify(terminal.response)} WHERE id = ${id}`;

          return yield* requireRun(id);
        }),
      );

    const recordToolCalls: StoreOperations["recordToolCalls"] = (
      runId,
      response,
      identities = [],
    ) =>
      transaction(
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          const run = yield* requireRun(yield* decodeInput(Id, runId));

          const decoded = yield* decodeInput(Completion, response, { onExcessProperty: "error" });

          const calls = decoded.output.flatMap((part) => (part.type === "tool-call" ? [part] : []));

          if (
            run.status !== "running" ||
            decoded.finishReason !== "tool-calls" ||
            calls.length === 0
          )
            return yield* conflict(
              "Only completed tool requests in a running run can be recorded.",
            );

          const saved = yield* toolCallsFor(runId);

          const ids = new Set([...saved, ...calls].map((call) => call.callId));

          if (ids.size !== saved.length + calls.length)
            return yield* conflict("Tool call IDs cannot be reused within a run.");

          const createdAt = Math.max(at, run.startedAt ?? run.createdAt);

          yield* sql`INSERT INTO tool_calls ${sql.insert(
            calls.map((call, index) => {
              const identity = identities.find((entry) => entry.callId === call.callId);

              return {
                runId,
                callId: call.callId,
                position: saved.length + index,
                name: call.name,
                namespace: call.namespace,
                arguments: call.arguments,
                serverId: identity?.serverId ?? null,
                toolName: identity?.toolName ?? null,
                status: "pending",
                createdAt,
              };
            }),
          )}`;

          yield* append(
            yield* requireSession(run.sessionId),
            runId,
            [{ role: "assistant", output: decoded.output, continuation: decoded.continuation }],
            createdAt,
          );

          return (yield* toolCallsFor(runId)).slice(saved.length);
        }),
      );

    const finishTool = (runId: string, callId: string, outcome: ToolOutcome) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        const { run, call } = yield* activeTool(runId, callId);
        const decoded = yield* decodeInput(ToolOutcome, outcome, { onExcessProperty: "error" });
        const finishedAt = Math.max(at, call.startedAt ?? call.createdAt);

        if (decoded.status === "completed" && call.status !== "running")
          return yield* conflict("Only a started tool call can complete.");

        // A reported failure keeps its reply in history only; the call row stores its reason.
        if ("output" in decoded)
          yield* append(
            yield* requireSession(run.sessionId),
            runId,
            [{ role: "tool", callId, output: decoded.output }],
            finishedAt,
          );

        const completed = decoded.status === "completed";

        yield* sql`UPDATE tool_calls SET status = ${decoded.status}, finished_at = ${finishedAt},
          output = ${completed ? decoded.output : null},
          failure_reason = ${completed ? null : decoded.reason}
          WHERE run_id = ${runId} AND call_id = ${callId}`;
      });

    return {
      createSession,
      queueRun,
      startRun,
      finishRun,
      recordToolCalls,
      startToolCall: (runId, callId) =>
        transaction(
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis;
            const { call } = yield* activeTool(runId, callId);

            if (call.status !== "pending")
              return yield* conflict("The tool call has already started.");

            yield* sql`UPDATE tool_calls SET status = 'running',
              started_at = ${Math.max(at, call.createdAt)}
              WHERE run_id = ${runId} AND call_id = ${callId}`;
          }),
        ),
      finishToolCall: (runId, callId, outcome) => transaction(finishTool(runId, callId, outcome)),
      commitToolCall: (runId, callId, operation) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const saved = yield* toolCallsFor(runId).pipe(
                Effect.map((calls) => calls.find((call) => call.callId === callId)),
                reportAs(storeFailure),
              );

              if (saved?.status === "completed") return saved.output!;

              const { call } = yield* activeTool(runId, callId).pipe(reportAs(storeFailure));

              if (call.status !== "running")
                return yield* conflict("Only a started tool call can commit a mutation.");

              const output = yield* operation;

              yield* finishTool(runId, callId, { status: "completed", output }).pipe(
                reportAs(storeFailure),
              );

              return output;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (error) =>
              logStorageCause(error).pipe(Effect.andThen(Effect.fail(storageFailure(error)))),
            ),
          ),
      toolCalls: (runId) =>
        Effect.gen(function* () {
          yield* requireRun(yield* decodeInput(Id, runId));

          return yield* toolCallsFor(runId);
        }).pipe(reportAs(storeFailure)),
      renameSession: (id, title) =>
        transaction(
          Effect.gen(function* () {
            yield* requireSession(yield* decodeInput(Id, id));

            yield* sql`UPDATE sessions SET title = ${yield* decodeInput(SessionTitle, title)},
            title_source = 'manual' WHERE id = ${id}`;

            return yield* requireSession(id);
          }),
        ),
      claimTitle: (id) =>
        transaction(
          Effect.gen(function* () {
            yield* requireSession(yield* decodeInput(Id, id));

            const claimed = yield* sql`UPDATE sessions SET title_attempted = 1
              WHERE id = ${id} AND title_source = 'fallback' AND title_attempted = 0
                AND EXISTS (SELECT 1 FROM runs WHERE session_id = ${id} AND status = 'completed')
              RETURNING id`;

            return claimed.length === 1 ? yield* requireSession(id) : null;
          }),
        ),
      // A generated title replaces only the fallback; manual names always win.
      finishTitle: (id, title, usage) =>
        transaction(
          Effect.gen(function* () {
            yield* requireSession(yield* decodeInput(Id, id));
            const generated = title === null ? null : yield* decodeInput(SessionTitle, title);

            yield* sql`UPDATE sessions
            SET title_usage = ${usage === null ? null : JSON.stringify(usage)},
              title = CASE WHEN title_source = 'fallback' AND ${generated} IS NOT NULL
                THEN ${generated} ELSE title END,
              title_source = CASE WHEN title_source = 'fallback' AND ${generated} IS NOT NULL
                THEN 'generated' ELSE title_source END
            WHERE id = ${id} AND title_attempted = 1`;
          }),
        ),
      searchSessions: (query, maxBytes) =>
        searchSessions(sql, query, maxBytes).pipe(reportAs(storeFailure)),
      readSession: (query, maxBytes) =>
        readSession(sql, query, maxBytes).pipe(reportAs(storeFailure)),
      session: (id) =>
        decodeInput(Id, id).pipe(Effect.flatMap(findSession), reportAs(storeFailure)),
      sessions: sql`SELECT * FROM sessions ORDER BY created_at, id`.pipe(
        decodeRows(SessionRow),
        reportAs(storeFailure),
      ),
      messages: (sessionId) =>
        Effect.gen(function* () {
          yield* requireSession(yield* decodeInput(Id, sessionId));

          return yield* sql`SELECT id, session_id, run_id, position, created_at, payload AS message
            FROM messages WHERE session_id = ${sessionId} ORDER BY position`.pipe(
            decodeRows(MessageRow),
          );
        }).pipe(reportAs(storeFailure)),
      run: (id) => decodeInput(Id, id).pipe(Effect.flatMap(findRun), reportAs(storeFailure)),
      runs: (sessionId) =>
        Effect.gen(function* () {
          yield* requireSession(yield* decodeInput(Id, sessionId));

          return yield* sql`${runs} WHERE runs.session_id = ${sessionId}
            ORDER BY runs.created_at, runs.id`.pipe(decodeRows(RunRow));
        }).pipe(reportAs(storeFailure)),
      status: sql`SELECT (SELECT COUNT(*) FROM sessions) AS sessions,
          (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM runs) AS runs`.pipe(
        decodeRow(
          Schema.Struct({
            sessions: Schema.Natural,
            messages: Schema.Natural,
            runs: Schema.Natural,
          }),
        ),
        Effect.map((counts) => ({
          path,
          schemaVersion: storeSchema.version,
          sessions: counts?.sessions ?? 0,
          messages: counts?.messages ?? 0,
          runs: counts?.runs ?? 0,
        })),
        reportAs(storeFailure),
      ),
    } satisfies StoreOperations;
  }),
).pipe(Layer.provideMerge(StoreDatabaseLive));
