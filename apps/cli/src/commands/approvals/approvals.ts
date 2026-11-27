import { Session, Store } from "@poppet/store";
import type { Approval } from "@poppet/store";
import { Clock, Data, Effect, Schema } from "effect";

export class ApprovalCommandError extends Data.TaggedError("ApprovalCommandError")<{
  readonly message: string;
}> {}

export const ApprovalCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({ action: Schema.Literals(["approve", "deny"]), id: Session.fields.id }),
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
});

export type DecidedApproval = typeof DecidedApproval.Type;

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

    const decision = command.action === "approve" ? "approved" : "denied";

    const decided = yield* store.decideApproval(command.id, {
      decision,
      adapter: "cli",
      senderId: "owner",
      at: yield* Clock.currentTimeMillis,
    });

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
    } satisfies DecidedApproval;
  });
