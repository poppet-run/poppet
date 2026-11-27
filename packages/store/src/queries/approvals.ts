import { createHash, randomUUID } from "node:crypto";

import { Clock, Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";

import { StoreError, decodeInput, reportAs, storeFailure } from "#src/errors";
import { conflict } from "#src/records";
import type { StoreRecords } from "#src/records";
import {
  Approval,
  ApprovalRule,
  ApprovalRuleCreator,
  ApprovalRuleMatcher,
  Id,
  NewApproval,
  NewApprovalRule,
  ToolApproval,
} from "#src/schema";
import type { ToolCall } from "#src/schema";
import type { StoreOperations } from "#src/service";
import { decodeRow, decodeRows } from "#src/sql";

const ApprovalRow = Schema.Struct({
  ...Approval.fields,
  request: Schema.fromJsonString(Approval.fields.request),
  requester: Schema.fromJsonString(Approval.fields.requester),
  decidedBy: Schema.NullOr(Schema.fromJsonString(ToolApproval)),
});

const ApprovalRuleRow = Schema.Struct({
  ...ApprovalRule.fields,
  matcher: Schema.fromJsonString(ApprovalRuleMatcher),
  createdBy: Schema.fromJsonString(ApprovalRuleCreator),
});

// Binds an approval to the exact saved call, so a resumed run can confirm what it dispatches.
export const callDigest = (call: Pick<ToolCall, "name" | "namespace" | "arguments">) =>
  createHash("sha256")
    .update(JSON.stringify([call.name, call.namespace, call.arguments]))
    .digest("hex");

export const ruleMatchDigest = (matcher: ApprovalRuleMatcher) =>
  createHash("sha256")
    .update(
      matcher.kind === "bash"
        ? JSON.stringify(["bash", matcher.command, matcher.cwd])
        : JSON.stringify(["mcp", matcher.serverId, matcher.toolName, matcher.origin]),
    )
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

  const findApprovalRule = (id: string) =>
    sql`SELECT * FROM approval_rules WHERE id = ${id}`.pipe(decodeRow(ApprovalRuleRow));

  const requireApprovalRule = (id: string) =>
    Effect.flatMap(findApprovalRule(id), (rule) =>
      rule === null
        ? Effect.die(new Error("A saved approval rule could not be read back."))
        : Effect.succeed(rule),
    );

  const upsertRule = (input: NewApprovalRule, at: number) =>
    Effect.gen(function* () {
      const rule = yield* decodeInput(NewApprovalRule, input, { onExcessProperty: "error" });
      const expiresAt = rule.expiresAt ?? null;

      if (expiresAt !== null && expiresAt <= at) {
        return yield* new StoreError({
          reason: "invalid-request",
          message: "An approval rule must expire after it is created.",
        });
      }

      const matchDigest = ruleMatchDigest(rule.matcher);

      const existing =
        yield* sql`SELECT * FROM approval_rules WHERE match_digest = ${matchDigest} AND revoked_at IS NULL`.pipe(
          decodeRow(ApprovalRuleRow),
        );

      if (existing !== null) {
        if (existing.expiresAt === null || existing.expiresAt > at) {
          return existing;
        }

        yield* sql`UPDATE approval_rules SET revoked_at = ${at} WHERE id = ${existing.id}`;
      }

      const id = randomUUID();

      yield* sql`INSERT INTO approval_rules ${sql.insert({
        id,
        kind: rule.matcher.kind,
        matchDigest,
        matcher: JSON.stringify(rule.matcher),
        createdAt: at,
        createdBy: JSON.stringify(rule.createdBy),
        sourceApprovalId: rule.sourceApprovalId ?? null,
        expiresAt,
      })}`;

      return yield* requireApprovalRule(id);
    });

  const decideApproval: StoreOperations["decideApproval"] = (id, answer, options) =>
    transaction(
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;

        const decodedAnswer = yield* decodeInput(ToolApproval, answer, {
          onExcessProperty: "error",
        });

        const approvalId = yield* decodeInput(Id, id);

        const existing = yield* sql`SELECT run_id, call_id FROM approvals
            WHERE id = ${approvalId} AND state = 'pending' AND expires_at > ${at}`.pipe(
          decodeRow(Schema.Struct({ runId: Id, callId: Schema.NonEmptyString })),
        );

        if (existing === null) {
          return null;
        }

        let decision = decodedAnswer;

        if (options?.rule !== undefined && decodedAnswer.decision === "approved") {
          const savedRule = yield* upsertRule(
            {
              matcher: options.rule,
              createdBy: {
                adapter: decodedAnswer.adapter,
                senderId: decodedAnswer.senderId,
                at: decodedAnswer.at,
              },
              sourceApprovalId: approvalId,
              expiresAt: options.expiresAt ?? null,
            },
            at,
          );

          decision = { ...decodedAnswer, ruleId: savedRule.id };
        }

        const claimed = yield* sql`UPDATE approvals SET state = ${decision.decision},
            decided_at = ${at}, decided_by = ${JSON.stringify(decision)}
          WHERE id = ${approvalId} AND state = 'pending' AND expires_at > ${at}
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

        return yield* requireApproval(approvalId);
      }),
    );

  const createApprovalRule: StoreOperations["createApprovalRule"] = (input) =>
    transaction(
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;

        return yield* upsertRule(input, at);
      }),
    );

  const matchApprovalRule: StoreOperations["matchApprovalRule"] = (matcher) =>
    transaction(
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;

        const decoded = yield* decodeInput(ApprovalRuleMatcher, matcher, {
          onExcessProperty: "error",
        });

        const matchDigest = ruleMatchDigest(decoded);

        return yield* sql`UPDATE approval_rules
          SET use_count = use_count + 1, last_used_at = ${at}
          WHERE match_digest = ${matchDigest}
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ${at})
          RETURNING *`.pipe(decodeRow(ApprovalRuleRow));
      }),
    );

  const revokeApprovalRule: StoreOperations["revokeApprovalRule"] = (id) =>
    transaction(
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        const ruleId = yield* decodeInput(Id, id);

        return yield* sql`UPDATE approval_rules SET revoked_at = ${at}
          WHERE id = ${ruleId} AND revoked_at IS NULL
          RETURNING *`.pipe(decodeRow(ApprovalRuleRow));
      }),
    );

  const revokeAllApprovalRules: StoreOperations["revokeAllApprovalRules"] = transaction(
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;

      return yield* sql`UPDATE approval_rules SET revoked_at = ${at}
        WHERE revoked_at IS NULL
        RETURNING *`.pipe(decodeRows(ApprovalRuleRow));
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
    latestApproval: (runId) =>
      decodeInput(Id, runId).pipe(
        Effect.flatMap((id) =>
          sql`SELECT * FROM approvals WHERE run_id = ${id}
            ORDER BY created_at DESC, rowid DESC LIMIT 1`.pipe(decodeRow(ApprovalRow)),
        ),
        reportAs(storeFailure),
      ),
    pendingApprovals: sql`SELECT * FROM approvals WHERE state = 'pending'
      ORDER BY created_at, id`.pipe(decodeRows(ApprovalRow), reportAs(storeFailure)),
    createApprovalRule,
    matchApprovalRule,
    approvalRule: (id) =>
      decodeInput(Id, id).pipe(Effect.flatMap(findApprovalRule), reportAs(storeFailure)),
    approvalRules: Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;

      return yield* sql`SELECT * FROM approval_rules
        WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ${at})
        ORDER BY created_at, id`.pipe(decodeRows(ApprovalRuleRow));
    }).pipe(reportAs(storeFailure)),
    revokeApprovalRule,
    revokeAllApprovalRules,
  } satisfies Pick<
    StoreOperations,
    | "parkRun"
    | "decideApproval"
    | "expireApprovals"
    | "approval"
    | "latestApproval"
    | "pendingApprovals"
    | "createApprovalRule"
    | "matchApprovalRule"
    | "approvalRule"
    | "approvalRules"
    | "revokeApprovalRule"
    | "revokeAllApprovalRules"
  >;
};
