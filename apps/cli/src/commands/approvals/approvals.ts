import { deriveApprovalRule, describeApprovalRule } from "@poppet/agent";
import { Session, Store } from "@poppet/store";
import type { Approval, ApprovalRule } from "@poppet/store";
import { Clock, Data, Effect, Option, Schema } from "effect";

export class ApprovalCommandError extends Data.TaggedError("ApprovalCommandError")<{
  readonly message: string;
}> {}

export const ApprovalCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({
    action: Schema.Literal("approve"),
    id: Session.fields.id,
    always: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ action: Schema.Literal("deny"), id: Session.fields.id }),
  Schema.Struct({ action: Schema.Literal("rules-list") }),
  Schema.Struct({
    action: Schema.Literal("rules-revoke"),
    id: Schema.optionalKey(Session.fields.id),
    all: Schema.optionalKey(Schema.Boolean),
  }),
]);

export type ApprovalCommand = typeof ApprovalCommand.Type;

export const PendingApproval = Schema.Struct({
  id: Session.fields.id,
  runId: Session.fields.id,
  kind: Schema.Literals(["bash", "mcp"]),
  summary: Schema.String,
  conversation: Schema.String,
  createdAt: Schema.Natural,
  expiresAt: Schema.Natural,
});

export type PendingApproval = typeof PendingApproval.Type;

export const DecidedApproval = Schema.Struct({
  id: Session.fields.id,
  runId: Session.fields.id,
  kind: Schema.Literals(["bash", "mcp"]),
  state: Schema.Literals(["approved", "denied"]),
  ruleId: Schema.optionalKey(Session.fields.id),
  ruleSummary: Schema.optionalKey(Schema.String),
});

export type DecidedApproval = typeof DecidedApproval.Type;

export const SavedApprovalRule = Schema.Struct({
  id: Session.fields.id,
  kind: Schema.Literals(["bash", "mcp"]),
  summary: Schema.String,
  createdAt: Schema.Natural,
  lastUsedAt: Schema.NullOr(Schema.Natural),
  useCount: Schema.Natural,
  expiresAt: Schema.NullOr(Schema.Natural),
});

export type SavedApprovalRule = typeof SavedApprovalRule.Type;

export const RevokedApprovalRules = Schema.Struct({
  revoked: Schema.Array(SavedApprovalRule),
});

export type RevokedApprovalRules = typeof RevokedApprovalRules.Type;

const ActionRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("bash"),
    command: Schema.String,
    cwd: Schema.String,
    timeoutSeconds: Schema.Number,
    reason: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("mcp"),
    invocation: Schema.String,
    target: Schema.String,
    effects: Schema.String,
    reason: Schema.String,
  }),
]);

const stringField = (value: Schema.JsonObject, key: string) => {
  const entry = value[key];

  return Schema.is(Schema.String)(entry) && entry.trim().length > 0 ? entry.trim() : null;
};

const summarizeRequest = (approval: Approval) => {
  if (approval.kind === "bash") {
    const command = stringField(approval.request, "command");

    if (command !== null) {
      return command;
    }
  } else {
    const target = stringField(approval.request, "target");
    const effects = stringField(approval.request, "effects");

    if (target !== null && effects !== null) {
      return `${target}: ${effects}`;
    }

    if (target !== null) {
      return target;
    }
  }

  return stringField(approval.request, "reason") ?? approval.kind;
};

const formatConversation = (requester: Schema.JsonObject) => {
  const adapter = stringField(requester, "adapter");
  const conversationId = stringField(requester, "conversationId");

  if (adapter !== null && conversationId !== null) {
    return `${adapter}:${conversationId}`;
  }

  return stringField(requester, "surface") ?? "unknown";
};

const toSavedRule = (rule: ApprovalRule): SavedApprovalRule => ({
  id: rule.id,
  kind: rule.kind,
  summary: describeApprovalRule(rule.matcher),
  createdAt: rule.createdAt,
  lastUsedAt: rule.lastUsedAt,
  useCount: rule.useCount,
  expiresAt: rule.expiresAt,
});

export const manageApprovals = (command: ApprovalCommand) =>
  Effect.gen(function* () {
    const store = yield* Store;

    if (command.action === "list") {
      yield* store.expireApprovals;
      const pending = yield* store.pendingApprovals;

      return pending.map((approval): PendingApproval => ({
        id: approval.id,
        runId: approval.runId,
        kind: approval.kind,
        summary: summarizeRequest(approval),
        conversation: formatConversation(approval.requester),
        createdAt: approval.createdAt,
        expiresAt: approval.expiresAt,
      }));
    }

    if (command.action === "rules-list") {
      const rules = yield* store.approvalRules;

      return rules.map(toSavedRule);
    }

    if (command.action === "rules-revoke") {
      if (command.all === true) {
        const revoked = yield* store.revokeAllApprovalRules;

        return { revoked: revoked.map(toSavedRule) } satisfies RevokedApprovalRules;
      }

      if (command.id === undefined) {
        return yield* Effect.fail(
          new ApprovalCommandError({ message: "Provide a rule ID or pass --all." }),
        );
      }

      const revoked = yield* store.revokeApprovalRule(command.id);

      if (revoked === null) {
        return yield* Effect.fail(
          new ApprovalCommandError({ message: "No matching active approval rule." }),
        );
      }

      return { revoked: [toSavedRule(revoked)] } satisfies RevokedApprovalRules;
    }

    const decision = command.action === "approve" ? "approved" : "denied";
    let rule = undefined;

    if (command.action === "approve" && command.always === true) {
      yield* store.expireApprovals;
      const current = yield* store.approval(command.id);

      if (current === null) {
        return yield* Effect.fail(
          new ApprovalCommandError({ message: "No matching pending approval." }),
        );
      }

      if (current.state !== "pending") {
        return yield* Effect.fail(
          new ApprovalCommandError({
            message: `This approval has already ended (${current.state}).`,
          }),
        );
      }

      const decoded = Schema.decodeUnknownOption(ActionRequest)(current.request);
      const derived = Option.isSome(decoded) ? deriveApprovalRule(decoded.value) : null;

      if (derived === null) {
        return yield* Effect.fail(
          new ApprovalCommandError({
            message:
              "A saved approval rule cannot be created for this action. Approve it once without --always.",
          }),
        );
      }

      rule = derived;
    }

    const decided = yield* store.decideApproval(
      command.id,
      {
        decision,
        adapter: "cli",
        senderId: "owner",
        at: yield* Clock.currentTimeMillis,
      },
      rule === undefined ? undefined : { rule },
    );

    if (decided === null) {
      yield* store.expireApprovals;
      const current = yield* store.approval(command.id);

      const message =
        current !== null && current.state !== "pending"
          ? `This approval has already ended (${current.state}).`
          : "No matching pending approval.";

      return yield* Effect.fail(new ApprovalCommandError({ message }));
    }

    return {
      id: decided.id,
      runId: decided.runId,
      kind: decided.kind,
      state: decision,
      ...(decided.decidedBy?.ruleId !== undefined && { ruleId: decided.decidedBy.ruleId }),
      ...(rule !== undefined && { ruleSummary: describeApprovalRule(rule) }),
    } satisfies DecidedApproval;
  });
