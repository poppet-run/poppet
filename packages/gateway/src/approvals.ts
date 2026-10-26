import { createHash, randomUUID } from "node:crypto";

import { AgentError, type CommandApproval } from "@poppet/agent";
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
  readonly decision: Deferred.Deferred<boolean>;
  readonly ready: Deferred.Deferred<void>;
  promptId: string | null;
  expiresAt: number;
}

const missing =
  "No matching pending approval in this conversation. It may have expired; request the operation again.";

/** Text replies and buttons consume the same one-time decision. */
export const commandApprovals = (channel: MessagingChannel["Service"]) => {
  const pending = new Map<string, PendingApproval>();

  /** Sends the prompt, waits up to two minutes, and rechecks access before approving. */
  const request = (message: IncomingMessage, conversation: string, approval: CommandApproval) =>
    Effect.gen(function* () {
      const id = randomUUID();
      const decision = yield* Deferred.make<boolean>();

      const entry: PendingApproval = {
        conversation,
        source: message,
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
        const details = `Bash approval required: ${approval.reason}\nExact invocation: ${JSON.stringify({ command: approval.command, cwd: approval.cwd, timeoutSeconds: approval.timeoutSeconds })}`;
        const controls = `Reply /approve ${id} or /deny ${id}. Expires in two minutes; permits one execution only.`;

        // Keep the fallback commands intact, with buttons only after all invocation details.
        const parts =
          `${details}\n${controls}`.length <= channel.textLimit
            ? [`${details}\n${controls}`]
            : [...chunks(details, channel.textLimit), controls];

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

        const approved = yield* Deferred.await(decision).pipe(
          Effect.timeout("2 minutes"),
          Effect.tapError(() =>
            Effect.sync(() => {
              expired = true;
            }),
          ),
        );

        if (approved) yield* channel.checkAccess(message, conversation);

        return approved && authorized(channel.policy, message);
      }).pipe(
        Effect.mapError(
          () =>
            new AgentError({
              reason: "command-approval-required",
              message: "Command approval expired or could not be confirmed. Nothing was executed.",
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

            // UI failure cannot undo the decision or keep cancellation waiting indefinitely.
            yield* channel.approvals.update(conversation, entry.promptId, id, state).pipe(
              Effect.timeout("5 seconds"),
              Effect.catch(() => Effect.void),
            );
          }),
        ),
      );
    });

  const settle = (id: string, entry: PendingApproval, approved: boolean) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      if (pending.get(id) !== entry || entry.promptId === null || now >= entry.expiresAt)
        return missing;

      pending.delete(id);
      yield* Deferred.succeed(entry.decision, approved);

      return approved ? "Approved this exact command once." : "Command denied.";
    }).pipe(Effect.uninterruptible, (effect) =>
      Deferred.await(entry.ready).pipe(Effect.andThen(effect)),
    );

  /** The text control path already checks the owner and current conversation access. */
  const answer = (conversation: string, text: string) =>
    Effect.gen(function* () {
      const reply = /^\/(approve|deny) ([a-f0-9-]{36})$/.exec(text.trim());
      const match = reply === null ? undefined : pending.get(reply[2]!);

      if (match === undefined || match.conversation !== conversation) return missing;

      return yield* settle(reply![2]!, match, reply![1] === "approve");
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

      return yield* settle(requestId, entry, action.decision === "approve");
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

export type CommandApprovals = ReturnType<typeof commandApprovals>;
