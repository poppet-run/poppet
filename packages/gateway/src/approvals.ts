import { createHash, randomUUID } from "node:crypto";

import { AgentError } from "@poppet/agent";
import type { ActionApproval, ApproveAction } from "@poppet/agent";
import { timeoutSeconds } from "@poppet/io";
import { StoreError } from "@poppet/store";
import type { ToolApproval } from "@poppet/store";
import { Cause, Clock, Deferred, Duration, Effect, Exit } from "effect";

import type {
  ApprovalAction,
  ApprovalSettlement,
  ApprovalState,
  GatewayAdapter,
  IncomingMessage,
} from "#src/adapter";
import {
  formatApprovalMessages,
  formatApprovalPrompt,
  formatApprovalStatus,
} from "#src/approval-format";
import { authorized } from "#src/context";

interface PendingApproval {
  readonly conversation: string;
  readonly source: IncomingMessage;
  readonly kind: ActionApproval["kind"];
  readonly decision: Deferred.Deferred<ToolApproval>;
  readonly ready: Deferred.Deferred<void>;
  promptId: string | null;
  expiresAt: number;
  decidedBy?: string;
}

const missing =
  "No matching pending approval in this conversation. It may have expired; request the operation again.";

export const actionApprovals = (adapter: GatewayAdapter["Service"]) => {
  const pending = new Map<string, PendingApproval>();

  const request = (
    message: IncomingMessage,
    conversation: string,
    approval: ActionApproval,
    recordAnswer?: Parameters<ApproveAction>[1],
  ) =>
    Effect.gen(function* () {
      const id = randomUUID();
      const decision = yield* Deferred.make<ToolApproval>();

      const entry: PendingApproval = {
        conversation,
        source: message,
        kind: approval.kind,
        decision,
        ready: yield* Deferred.make<void>(),
        promptId: null,
        expiresAt: 0,
      };

      pending.set(id, entry);
      let expired = false;

      return yield* Effect.gen(function* () {
        if (!authorized(adapter.policy, message)) {
          return false;
        }

        yield* adapter.checkAccess(message, conversation);

        const expiresAfter = yield* timeoutSeconds("approvalSeconds");
        entry.expiresAt = (yield* Clock.currentTimeMillis) + expiresAfter * 1000;

        const prompt = formatApprovalPrompt({
          requestId: id,
          approval,
          expiresAt: entry.expiresAt,
          expiresAfterSeconds: expiresAfter,
        });

        if (adapter.approvals) {
          const nonce = createHash("sha256").update(`${id}-0`).digest("hex").slice(0, 24);
          entry.promptId = yield* adapter.approvals.send(conversation, prompt, nonce);
        } else {
          const parts = formatApprovalMessages(prompt, adapter.textLimit);

          for (const [index, part] of parts.entries()) {
            const nonce = createHash("sha256").update(`${id}-${index}`).digest("hex").slice(0, 24);
            const sent = yield* adapter.send(conversation, part, nonce);

            if (index === parts.length - 1) {
              entry.promptId = sent;
            }
          }
        }

        yield* Deferred.succeed(entry.ready, undefined);

        const answer = yield* Deferred.await(decision).pipe(
          Effect.timeout(Duration.seconds(expiresAfter)),
          Effect.tapError(() =>
            Effect.sync(() => {
              expired = true;
            }),
          ),
        );

        if (recordAnswer !== undefined) {
          yield* recordAnswer(answer);
        }

        if (answer.decision === "approved") {
          yield* adapter.checkAccess(message, conversation);
        }

        return answer.decision === "approved" && authorized(adapter.policy, message);
      }).pipe(
        Effect.mapError((error) =>
          error instanceof StoreError
            ? error
            : new AgentError({
                reason:
                  approval.kind === "mcp" ? "mcp-approval-required" : "command-approval-required",
                message: `${approval.kind === "mcp" ? "MCP action" : "Command"} approval expired or could not be confirmed. Nothing was executed.`,
              }),
        ),
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            pending.delete(id);
            yield* Deferred.succeed(entry.ready, undefined);

            if (entry.promptId === null || !adapter.approvals) {
              return;
            }

            const state: ApprovalState = Exit.isSuccess(exit)
              ? exit.value
                ? "approved"
                : "denied"
              : Cause.hasInterrupts(exit.cause)
                ? "cancelled"
                : expired
                  ? "expired"
                  : "unavailable";

            const settlement: ApprovalSettlement = {
              ...(entry.decidedBy !== undefined &&
                (state === "approved" || state === "denied") && { senderId: entry.decidedBy }),
              text: formatApprovalStatus(state),
            };

            yield* adapter.approvals
              .update(conversation, entry.promptId, id, state, settlement)
              .pipe(
                Effect.timeout("5 seconds"),
                Effect.catch(() => Effect.void),
              );
          }),
        ),
      );
    });

  const settle = (id: string, entry: PendingApproval, source: IncomingMessage, approved: boolean) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      if (pending.get(id) !== entry || entry.promptId === null || now >= entry.expiresAt) {
        return missing;
      }

      pending.delete(id);
      entry.decidedBy = source.senderId;
      yield* Deferred.succeed(entry.decision, {
        decision: approved ? "approved" : "denied",
        adapter: adapter.id,
        senderId: source.senderId,
        at: now,
      } satisfies ToolApproval);

      if (entry.kind === "mcp") {
        return approved ? "Approved this exact MCP action once." : "MCP action denied.";
      }

      return approved ? "Approved this exact command once." : "Command denied.";
    }).pipe(Effect.uninterruptible, (effect) =>
      Deferred.await(entry.ready).pipe(Effect.andThen(effect)),
    );

  const answer = (conversation: string, source: IncomingMessage) =>
    Effect.gen(function* () {
      if (!authorized(adapter.policy, source)) {
        return "Only the configured owner can answer this approval.";
      }

      const reply = /^\/(approve|deny) ([a-f0-9-]{36})$/.exec(source.text.trim());
      const requestId = reply?.[2];
      const match = requestId === undefined ? undefined : pending.get(requestId);

      if (
        reply === null ||
        requestId === undefined ||
        match === undefined ||
        match.conversation !== conversation ||
        source.conversationId !== conversation ||
        source.parentId !== match.source.parentId
      ) {
        return missing;
      }

      return yield* settle(requestId, match, source, reply[1] === "approve");
    });

  const answerAction = (action: ApprovalAction) =>
    Effect.gen(function* () {
      const { source, requestId } = action;

      if (!authorized(adapter.policy, source)) {
        return "Only the configured owner can answer this approval.";
      }

      const entry = pending.get(requestId);

      if (
        entry === undefined ||
        source.conversationId !== entry.conversation ||
        source.parentId !== entry.source.parentId
      ) {
        return missing;
      }

      yield* Deferred.await(entry.ready);

      if (source.messageId !== entry.promptId) {
        return missing;
      }

      yield* adapter.checkAccess(source, entry.conversation);

      return yield* settle(requestId, entry, source, action.decision === "approve");
    }).pipe(
      Effect.catchTag("GatewayError", () =>
        Effect.succeed(
          "Approval could not be confirmed. Check access and try again before it expires.",
        ),
      ),
      Effect.flatMap(action.reply),
      Effect.catchTag("GatewayError", () => Effect.void),
    );

  return { request, answer, answerAction };
};

export type ActionApprovals = ReturnType<typeof actionApprovals>;
