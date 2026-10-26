import { randomUUID } from "node:crypto";

import { Message } from "@poppet/provider";
import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { StoreError, decodeInput, reportAs, storeFailure } from "#src/errors";
import { RunRow, conflict, type StoreRecords } from "#src/records";
import { Id, NewAttachment, RunOutcome, SavedAttachment, SessionTitle } from "#src/schema";
import type { StoreOperations } from "#src/service";
import { decodeRows } from "#src/sql";

export const runOperations = (sql: SqlClient.SqlClient, records: StoreRecords) => {
  const {
    transaction,
    requireSession,
    runs,
    findRun,
    requireRun,
    toolCallsFor,
    repliedCalls,
    interruptTools,
    touch,
    append,
  } = records;

  const queueRun: StoreOperations["queueRun"] = (
    sessionId,
    input,
    runId = randomUUID(),
    fallbackTitle,
    newAttachments = [],
  ) =>
    transaction(
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;

        const messages = yield* decodeInput(Schema.Array(Message), input, {
          onExcessProperty: "error",
        });

        const session = yield* requireSession(yield* decodeInput(Id, sessionId));

        const active = yield* sql`SELECT id FROM runs WHERE session_id = ${sessionId}
          AND status IN ('pending', 'running')`;

        if (active.length > 0)
          return yield* conflict("This session already has a pending or running run.");

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

        const attachments = yield* decodeInput(Schema.Array(NewAttachment), newAttachments, {
          onExcessProperty: "error",
        });

        const references = messages.flatMap((message) =>
          message.role === "user" ? (message.attachments ?? []) : [],
        );

        // Every reference names exactly one attachment saved with it, and nothing else is saved.
        if (
          references.length !== attachments.length ||
          references.some((reference, index) => {
            const attachment = attachments[index]!;

            return (
              reference.id !== attachment.id ||
              reference.name !== attachment.name ||
              reference.mediaType !== attachment.mediaType ||
              reference.size !== attachment.body.length
            );
          })
        )
          return yield* new StoreError({
            reason: "invalid-request",
            message: "Attachments must match the references in the queued messages.",
          });

        if (attachments.length > 0)
          yield* sql`INSERT INTO attachments ${sql.insert(
            attachments.map((attachment) => ({
              id: attachment.id,
              sessionId,
              name: attachment.name,
              mediaType: attachment.mediaType,
              size: attachment.body.length,
              createdAt,
              body: attachment.body,
            })),
          )}`;

        yield* append(session, runId, messages, createdAt);

        return yield* requireRun(runId);
      }),
    );

  const startRun: StoreOperations["startRun"] = (id) =>
    transaction(
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        const run = yield* requireRun(yield* decodeInput(Id, id));

        if (run.status !== "pending") return yield* conflict("Only a pending run can be started.");

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

  return {
    queueRun,
    startRun,
    finishRun,
    run: (id) => decodeInput(Id, id).pipe(Effect.flatMap(findRun), reportAs(storeFailure)),
    runs: (sessionId) =>
      Effect.gen(function* () {
        yield* requireSession(yield* decodeInput(Id, sessionId));

        return yield* sql`${runs} WHERE runs.session_id = ${sessionId}
            ORDER BY runs.created_at, runs.id`.pipe(decodeRows(RunRow));
      }).pipe(reportAs(storeFailure)),
    attachments: (sessionId, ids) =>
      Effect.gen(function* () {
        yield* decodeInput(Id, sessionId);

        if (ids.length === 0) return [];

        return yield* sql`SELECT id, media_type, body FROM attachments
            WHERE session_id = ${sessionId} AND ${sql.in("id", ids)}`.pipe(
          decodeRows(SavedAttachment),
        );
      }).pipe(reportAs(storeFailure)),
  } satisfies Pick<
    StoreOperations,
    "queueRun" | "startRun" | "finishRun" | "run" | "runs" | "attachments"
  >;
};
