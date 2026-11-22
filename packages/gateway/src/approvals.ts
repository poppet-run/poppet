import { createHash, randomUUID } from "node:crypto";

import {
  AgentError,
  escapedApprovalJSON,
  type ActionApproval,
  type ApproveAction,
} from "@poppet/agent";
import { StoreError, type ToolApproval } from "@poppet/store";
import { Cause, Clock, Deferred, Effect, Exit } from "effect";

import type {
  ApprovalAction,
  ApprovalState,
  IncomingMessage,
  MessagingChannel,
} from "#src/channel";
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

export const actionApprovals = (channel: MessagingChannel["Service"]) => {
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
        if (!authorized(channel.policy, message)) return false;
        yield* channel.checkAccess(message, conversation);

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
            chunks(escapedApprovalJSON(value), channel.textLimit - label.length - 4).map(
              (part) => `${label}: \`${part}\``,
            ),
          ),
          "Exact invocation:",
        ];

        const heading = headingParts.join("\n");
        const details = `${heading} \`${invocation}\``;
        const controls = `Reply \`/approve ${id}\` or \`/deny ${id}\`. Expires in two minutes; permits one execution only.`;

        const parts =
          `${details}\n${controls}`.length <= channel.textLimit
            ? [`${details}\n${controls}`]
            : [
                ...(heading.length <= channel.textLimit ? [heading] : headingParts),
                ...chunks(invocation, channel.textLimit - 2).map((part) => `\`${part}\``),
                controls,
              ];

        for (const [index, part] of parts.entries()) {
          const nonce = createHash("sha256").update(`${id}-${index}`).digest("hex").slice(0, 24);
          const last = index === parts.length - 1;

          const sent = yield* last && channel.approvals
            ? channel.approvals.send(conversation, part, nonce, id)
            : channel.send(conversation, part, nonce);

          if (last) entry.promptId = sent;
        }

        entry.expiresAt = (yield* Clock.currentTimeMillis) + 120_000;
        yield* Deferred.succeed(entry.ready, undefined);

        const answer = yield* Deferred.await(decision).pipe(
          Effect.timeout("2 minutes"),
          Effect.tapError(() =>
            Effect.sync(() => {
              expired = true;
            }),
          ),
        );

        if (recordAnswer !== undefined) yield* recordAnswer(answer);

        if (answer.decision === "approved") yield* channel.checkAccess(message, conversation);

        return answer.decision === "approved" && authorized(channel.policy, message);
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

            if (entry.promptId === null || !channel.approvals) return;

            const state: ApprovalState = Exit.isSuccess(exit)
              ? exit.value
                ? "approved"
                : "denied"
              : Cause.hasInterrupts(exit.cause)
                ? "cancelled"
                : expired
                  ? "expired"
                  : "unavailable";

            yield* channel.approvals.update(conversation, entry.promptId, id, state).pipe(
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

      if (pending.get(id) !== entry || entry.promptId === null || now >= entry.expiresAt)
        return missing;

      pending.delete(id);
      yield* Deferred.succeed(entry.decision, {
        decision: approved ? "approved" : "denied",
        adapter: channel.id,
        senderId: source.senderId,
        at: now,
      } satisfies ToolApproval);

      if (entry.kind === "mcp")
        return approved ? "Approved this exact MCP action once." : "MCP action denied.";

      return approved ? "Approved this exact command once." : "Command denied.";
    }).pipe(Effect.uninterruptible, (effect) =>
      Deferred.await(entry.ready).pipe(Effect.andThen(effect)),
    );

  const answer = (conversation: string, source: IncomingMessage) =>
    Effect.gen(function* () {
      if (!authorized(channel.policy, source))
        return "Only the configured owner can answer this approval.";

      const reply = /^\/(approve|deny) ([a-f0-9-]{36})$/.exec(source.text.trim());
      const match = reply === null ? undefined : pending.get(reply[2]!);

      if (
        match === undefined ||
        match.conversation !== conversation ||
        source.conversationId !== conversation ||
        source.parentId !== match.source.parentId
      )
        return missing;

      return yield* settle(reply![2]!, match, source, reply![1] === "approve");
    });

  const answerAction = (action: ApprovalAction) =>
    Effect.gen(function* () {
      const { source, requestId } = action;

      if (!authorized(channel.policy, source))
        return "Only the configured owner can answer this approval.";
      const entry = pending.get(requestId);

      if (
        entry === undefined ||
        source.conversationId !== entry.conversation ||
        source.parentId !== entry.source.parentId
      )
        return missing;

      yield* Deferred.await(entry.ready);

      if (source.messageId !== entry.promptId) return missing;

      yield* channel.checkAccess(source, entry.conversation);

      return yield* settle(requestId, entry, source, action.decision === "approve");
    }).pipe(
      Effect.catchTag("ChannelError", () =>
        Effect.succeed(
          "Approval could not be confirmed. Check access and try again before it expires.",
        ),
      ),
      Effect.flatMap(action.reply),
      Effect.catchTag("ChannelError", () => Effect.void),
    );

  return { request, answer, answerAction };
};

export type ActionApprovals = ReturnType<typeof actionApprovals>;
