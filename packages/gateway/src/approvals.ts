import { createHash, randomUUID } from "node:crypto";

import { AgentError, type CommandApproval } from "@poppet/agent";
import { Deferred, Effect } from "effect";

import type { IncomingMessage, MessagingChannel } from "#src/channel";
import { authorized } from "#src/context";
import { chunks } from "#src/replies";

/** Asks the owner to approve one exact command and settles it from their reply. */
export const commandApprovals = (channel: MessagingChannel["Service"]) => {
  const pending = new Map<string, { conversation: string; decision: Deferred.Deferred<boolean> }>();

  /** Sends the prompt, waits up to two minutes, and rechecks access before approving. */
  const request = (message: IncomingMessage, conversation: string, approval: CommandApproval) =>
    Effect.gen(function* () {
      const id = randomUUID();
      const decision = yield* Deferred.make<boolean>();
      pending.set(id, { conversation, decision });

      return yield* Effect.gen(function* () {
        if (!authorized(channel.policy, message)) return false;
        yield* channel.checkAccess(message, conversation);
        const text = `Bash approval required: ${approval.reason}\nExact invocation: ${JSON.stringify({ command: approval.command, cwd: approval.cwd, timeoutSeconds: approval.timeoutSeconds })}\nReply /approve ${id} or /deny ${id}. Expires in two minutes; permits one execution only.`;

        for (const [index, part] of chunks(text, channel.textLimit).entries())
          yield* channel.send(
            conversation,
            part,
            createHash("sha256").update(`${id}-${index}`).digest("hex").slice(0, 24),
          );
        const approved = yield* Deferred.await(decision).pipe(Effect.timeout("2 minutes"));

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
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(id);
          }),
        ),
      );
    });

  /** Settles a pending approval from an /approve or /deny reply and returns the reply text. */
  const answer = (conversation: string, text: string) =>
    Effect.gen(function* () {
      const reply = /^\/(approve|deny) ([a-f0-9-]{36})$/.exec(text.trim());
      const match = reply === null ? undefined : pending.get(reply[2]!);

      if (match === undefined || match.conversation !== conversation)
        return "No matching pending approval in this conversation. It may have expired; request the operation again.";

      pending.delete(reply![2]!);
      yield* Deferred.succeed(match.decision, reply![1] === "approve");

      return reply![1] === "approve" ? "Approved this exact command once." : "Command denied.";
    });

  return { request, answer };
};

export type CommandApprovals = ReturnType<typeof commandApprovals>;
