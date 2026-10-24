import { Completion } from "@poppet/provider";
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";

import { decodeInput, logStorageCause, reportAs, storageFailure, storeFailure } from "#src/errors";
import { conflict, type StoreRecords } from "#src/records";
import { Id, ToolOutcome } from "#src/schema";
import type { StoreOperations } from "#src/service";

export const toolCallOperations = (sql: SqlClient.SqlClient, records: StoreRecords) => {
  const { transaction, requireSession, requireRun, toolCallsFor, activeTool, append } = records;

  const recordToolCalls: StoreOperations["recordToolCalls"] = (runId, response, identities = []) =>
    transaction(
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        const run = yield* requireRun(yield* decodeInput(Id, runId));

        const decoded = yield* decodeInput(Completion, response, { onExcessProperty: "error" });

        const calls = decoded.output.flatMap((part) => (part.type === "tool-call" ? [part] : []));

        if (run.status !== "running" || decoded.finishReason !== "tool-calls" || calls.length === 0)
          return yield* conflict("Only completed tool requests in a running run can be recorded.");

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
  } satisfies Pick<
    StoreOperations,
    "recordToolCalls" | "startToolCall" | "finishToolCall" | "commitToolCall" | "toolCalls"
  >;
};
