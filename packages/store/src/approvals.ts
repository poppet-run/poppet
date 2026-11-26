import { createHash, randomUUID } from "node:crypto";

import { Clock, Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";

import { StoreError, decodeInput, reportAs, storeFailure } from "#src/errors";
import { conflict } from "#src/records";
import type { StoreRecords } from "#src/records";
import { Approval, Id, NewApproval, ToolApproval } from "#src/schema";
import type { ToolCall } from "#src/schema";
import type { StoreOperations } from "#src/service";
import { decodeRow, decodeRows } from "#src/sql";

const ApprovalRow = Schema.Struct({
  ...Approval.fields,
  request: Schema.fromJsonString(Approval.fields.request),
  requester: Schema.fromJsonString(Approval.fields.requester),
  decidedBy: Schema.NullOr(Schema.fromJsonString(ToolApproval)),
});

// Binds an approval to the exact saved call, so a resumed run can confirm what it dispatches.
export const callDigest = (call: Pick<ToolCall, "name" | "namespace" | "arguments">) =>
  createHash("sha256")
    .update(JSON.stringify([call.name, call.namespace, call.arguments]))
    .digest("hex");

const approvalRequired = (kind: Approval["kind"]) =>
  kind === "mcp" ? "agent:mcp-approval-required" : "agent:command-approval-required";

export const approvalOperations = (sql: SqlClient.SqlClient, records: StoreRecords) => {
  const { transaction, activeTool, toolCallsFor, requireRun, interruptTools, touch } = records;

  const findApproval = (id: string) =>
    sql`SELECT * FROM approvals WHERE id = ${id}`.pipe(decodeRow(ApprovalRow));

  const requireApproval = (id: string) =>
    Effect.flatMap(findApproval(id), (approval) =>
      approval === null
        ? Effect.die(new Error("A saved approval could not be read back."))
        : Effect.succeed(approval),
    );

  const parkRun: StoreOperations["parkRun"] = (runId, callId, input) =>
    transaction(
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        const { call } = yield* activeTool(runId, callId);
        const approval = yield* decodeInput(NewApproval, input, { onExcessProperty: "error" });

        if (
          call.status !== "pending" ||
          call.review?.decision !== "needs_approval" ||
          call.review.approval !== undefined
        ) {
          return yield* conflict("Only a pending call that needs owner approval can wait.");
        }

        if (approval.expiresAt <= at) {
          return yield* new StoreError({
            reason: "invalid-request",
            message: "An approval must expire after it is requested.",
          });
        }

        const id = randomUUID();

        yield* sql`INSERT INTO approvals ${sql.insert({
          id,
          runId,
          callId,
          kind: approval.kind,
          request: JSON.stringify(approval.request),
          digest: callDigest(call),
          requester: JSON.stringify(approval.requester),
          state: "pending",
          createdAt: at,
          expiresAt: approval.expiresAt,
        })}`;

        return yield* requireApproval(id);
      }),
    );

  const decideApproval: StoreOperations["decideApproval"] = (id, answer) =>
    transaction(
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        const decision = yield* decodeInput(ToolApproval, answer, { onExcessProperty: "error" });

        const claimed = yield* sql`UPDATE approvals SET state = ${decision.decision},
            decided_at = ${at}, decided_by = ${JSON.stringify(decision)}
          WHERE id = ${yield* decodeInput(Id, id)} AND state = 'pending' AND expires_at > ${at}
          RETURNING run_id, call_id`.pipe(
          decodeRow(Schema.Struct({ runId: Id, callId: Schema.NonEmptyString })),
        );

        if (claimed === null) {
          return null;
        }

        const call = (yield* toolCallsFor(claimed.runId)).find(
          (entry) => entry.callId === claimed.callId,
        );

        if (call?.review?.decision !== "needs_approval") {
          return yield* conflict("A waiting call must keep its needs_approval review.");
        }

        yield* sql`UPDATE tool_calls SET review = ${JSON.stringify({ ...call.review, approval: decision })}
          WHERE run_id = ${claimed.runId} AND call_id = ${claimed.callId}`;

        return yield* requireApproval(id);
      }),
    );

  const expireApprovals: StoreOperations["expireApprovals"] = transaction(
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;

      const expired = yield* sql`UPDATE approvals SET state = 'expired', decided_at = ${at}
          WHERE state = 'pending' AND expires_at <= ${at} RETURNING *`.pipe(
        decodeRows(ApprovalRow),
      );

      for (const approval of expired) {
        const run = yield* requireRun(approval.runId);
        const reason = approvalRequired(approval.kind);
        const finishedAt = Math.max(at, run.createdAt, run.startedAt ?? 0);

        yield* interruptTools(run.id, finishedAt, reason);
        yield* sql`UPDATE runs SET status = 'failed', finished_at = ${finishedAt},
            failure_reason = ${reason} WHERE id = ${run.id} AND status = 'running'`;
        yield* touch(run.sessionId, finishedAt);
      }

      return expired;
    }),
  );

  return {
    parkRun,
    decideApproval,
    expireApprovals,
    approval: (id) =>
      decodeInput(Id, id).pipe(Effect.flatMap(findApproval), reportAs(storeFailure)),
  } satisfies Pick<StoreOperations, "parkRun" | "decideApproval" | "expireApprovals" | "approval">;
};
