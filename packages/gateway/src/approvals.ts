import { createHash, randomUUID } from "node:crypto";

import { AgentError, escapedApprovalJSON } from "@poppet/agent";
import type { ActionApproval, ApproveAction } from "@poppet/agent";
import { timeoutSeconds } from "@poppet/io";
import { StoreError } from "@poppet/store";
import type { ToolApproval } from "@poppet/store";
import { Cause, Clock, Deferred, Duration, Effect, Exit } from "effect";

import type { ApprovalAction, ApprovalState, GatewayAdapter, IncomingMessage } from "#src/adapter";
import { authorized } from "#src/context";
import { chunks } from "#src/replies";

interface PendingApproval {
  readonly conversation: string;
  readonly source: IncomingMessage;
  readonly kind: ActionApproval["kind"];
  readonly decision: Deferred.Deferred<ToolApproval>;
  readonly ready: Deferred.Deferred<void>;
  promptId: string | null;
  expiresAt: number;
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

        const invocation =
          approval.kind === "mcp"
            ? approval.invocation
            : escapedApprovalJSON({
                command: approval.command,
                cwd: approval.cwd,
                timeoutSeconds: approval.timeoutSeconds,
              });

        const fields =
          approval.kind === "mcp"
            ? ([
                ["Target", approval.target],
                ["Expected effects", approval.effects],
                ["Review reason", approval.reason],
              ] as const)
            : ([["Review reason", approval.reason]] as const);

        const headingParts = [
          approval.kind === "mcp" ? "MCP action approval required" : "Bash approval required",
          ...fields.flatMap(([label, value]) =>
            chunks(escapedApprovalJSON(value), adapter.textLimit - label.length - 4).map(
              (part) => `${label}: \`${part}\``,
            ),
          ),
          "Exact invocation:",
        ];

        const heading = headingParts.join("\n");
        const details = `${heading} \`${invocation}\``;
        const expiresAfter = yield* timeoutSeconds("approvalSeconds");

        const expiry =
          expiresAfter % 60 === 0
            ? `${expiresAfter / 60} ${expiresAfter === 60 ? "minute" : "minutes"}`
            : `${expiresAfter} seconds`;

        const controls = `Reply \`/approve ${id}\` or \`/deny ${id}\`. Expires in ${expiry}; permits one execution only.`;

        const parts =
          `${details}\n${controls}`.length <= adapter.textLimit
            ? [`${details}\n${controls}`]
            : [
                ...(heading.length <= adapter.textLimit ? [heading] : headingParts),
                ...chunks(invocation, adapter.textLimit - 2).map((part) => `\`${part}\``),
                controls,
              ];

        for (const [index, part] of parts.entries()) {
          const nonce = createHash("sha256").update(`${id}-${index}`).digest("hex").slice(0, 24);
          const last = index === parts.length - 1;

          const sent = yield* last && adapter.approvals
            ? adapter.approvals.send(conversation, part, nonce, id)
            : adapter.send(conversation, part, nonce);

          if (last) {
            entry.promptId = sent;
          }
        }

        entry.expiresAt = (yield* Clock.currentTimeMillis) + expiresAfter * 1000;
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

            yield* adapter.approvals.update(conversation, entry.promptId, id, state).pipe(
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
