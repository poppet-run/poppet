import { randomUUID } from "node:crypto";

import { ProviderId } from "@poppet/provider";
import { Clock, Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";

import { decodeInput, reportAs, storeFailure } from "#src/errors";
import { conflict, SessionRow, MessageRow } from "#src/records";
import type { StoreRecords } from "#src/records";
import { Id, ModelId, SessionTitle, SkillSnapshot } from "#src/schema";
import type { StoreOperations } from "#src/service";
import { decodeRows } from "#src/sql";

export const sessionOperations = (sql: SqlClient.SqlClient, records: StoreRecords) => {
  const { transaction, findSession, requireSession } = records;

  const createSession: StoreOperations["createSession"] = (
    provider,
    model,
    { id = randomUUID(), taskTitle, origin = "chat", skill = null } = {},
  ) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;

      const title =
        taskTitle === undefined ? "New conversation" : yield* decodeInput(SessionTitle, taskTitle);

      yield* sql`INSERT INTO sessions ${sql.insert({
        id: yield* decodeInput(Id, id),
        provider: yield* decodeInput(ProviderId, provider),
        model: yield* decodeInput(ModelId, model),
        createdAt: at,
        updatedAt: at,
        title,
        origin,
        titleSource: taskTitle === undefined ? "fallback" : "task",
        titleAttempted: taskTitle === undefined ? 0 : 1,
        skill: skill === null ? null : JSON.stringify(yield* decodeInput(SkillSnapshot, skill)),
      })}`;

      return yield* requireSession(id);
    }).pipe(reportAs(storeFailure));

  const removeRows = (ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (ids.length === 0) return;
      const sessions = sql.in("session_id", ids);
      const runs = sql`SELECT id FROM runs WHERE ${sessions}`;

      yield* sql`DELETE FROM session_search
        WHERE rowid IN (SELECT id FROM messages WHERE ${sessions})`;
      yield* sql`DELETE FROM tool_calls WHERE run_id IN (${runs})`;
      yield* sql`DELETE FROM messages WHERE ${sessions}`;
      yield* sql`DELETE FROM attachments WHERE ${sessions}`;
      yield* sql`DELETE FROM runs WHERE ${sessions}`;
      yield* sql`DELETE FROM sessions WHERE ${sql.in("id", ids)}`;
    });

  const idle = sql`NOT EXISTS (SELECT 1 FROM runs
    WHERE runs.session_id = sessions.id AND runs.status IN ('pending', 'running'))`;

  return {
    createSession,
    deleteSessions: (ids) =>
      transaction(
        Effect.gen(function* () {
          const selected = [...new Set(yield* decodeInput(Schema.Array(Id), ids))];
          const sessions = yield* Effect.forEach(selected, requireSession);

          const busy =
            yield* sql`SELECT id FROM sessions WHERE ${sql.in("id", selected)} AND NOT ${idle}`;

          if (busy.length > 0)
            return yield* conflict(
              "A reply is in progress in this session. Stop it before deleting the session.",
            );
          yield* removeRows(selected);

          return sessions;
        }),
      ),
    pruneSessions: (before, { dryRun }) =>
      transaction(
        Effect.gen(function* () {
          const sessions = yield* sql`SELECT * FROM sessions
            WHERE updated_at < ${yield* decodeInput(Schema.Int, before)} AND ${idle}
            ORDER BY updated_at, id`.pipe(decodeRows(SessionRow));

          if (!dryRun) yield* removeRows(sessions.map((session) => session.id));

          return sessions;
        }),
      ),
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
    session: (id) => decodeInput(Id, id).pipe(Effect.flatMap(findSession), reportAs(storeFailure)),
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
  } satisfies Pick<
    StoreOperations,
    | "createSession"
    | "deleteSessions"
    | "pruneSessions"
    | "renameSession"
    | "claimTitle"
    | "finishTitle"
    | "session"
    | "sessions"
    | "messages"
  >;
};
