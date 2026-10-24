import { randomUUID } from "node:crypto";

import { ProviderId } from "@poppet/provider";
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";

import { decodeInput, reportAs, storeFailure } from "#src/errors";
import { SessionRow, MessageRow, type StoreRecords } from "#src/records";
import { Id, ModelId, Session, SessionTitle, SkillSnapshot } from "#src/schema";
import type { StoreOperations } from "#src/service";
import { decodeRows } from "#src/sql";

export const sessionOperations = (sql: SqlClient.SqlClient, records: StoreRecords) => {
  const { transaction, findSession, requireSession } = records;

  const createSession: StoreOperations["createSession"] = (
    provider,
    model,
    { workload = "assistant", id = randomUUID(), taskTitle, skill = null } = {},
  ) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;

      const title =
        taskTitle === undefined ? "New conversation" : yield* decodeInput(SessionTitle, taskTitle);

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

  return {
    createSession,
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
    | "renameSession"
    | "claimTitle"
    | "finishTitle"
    | "session"
    | "sessions"
    | "messages"
  >;
};
