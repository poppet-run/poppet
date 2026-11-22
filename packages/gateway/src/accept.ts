import { Effect, Fiber, Schema } from "effect";

import type { ActionApprovals } from "#src/approvals";
import { ChannelError, IncomingMessage } from "#src/channel";
import {
  authorized,
  finish,
  mark,
  wake,
  type GatewayContext,
  type RunningRequest,
} from "#src/context";
import type { Inbox } from "#src/repository";
import { isApprovalReply, isControl } from "#src/request";

export interface Controls {
  readonly approvals: ActionApprovals;
  readonly running: RunningRequest;
}

const controlReply = (
  context: GatewayContext,
  controls: Controls,
  entry: Inbox,
  message: IncomingMessage,
  conversation: string,
  session: string,
) =>
  Effect.gen(function* () {
    const { channel, repo, store } = context;

    if (isApprovalReply(message.text)) {
      yield* channel.checkAccess(message, conversation);

      return yield* controls.approvals.answer(conversation, message);
    }

    if (message.text.trim() === "/cancel") {
      const { requests, claims } = controls.running;

      yield* claims.withPermit(
        Effect.gen(function* () {
          yield* repo.cancel(channel.id, entry.account, message.scopeId, conversation);

          for (const request of requests.values())
            if (
              request.entry.account === entry.account &&
              request.entry.message.scopeId === message.scopeId &&
              request.entry.conversationId === conversation
            ) {
              yield* repo.state(request.entry.id, "cancelled");
              yield* Fiber.interrupt(request.fiber);
            }
        }),
      );

      return "Cancelled this thread's queued and active request.";
    }

    const latest = (yield* store.runs(session)).at(-1);
    const savedSession = yield* store.session(session);

    return `Session: ${session}\nTitle: ${savedSession?.title ?? session}\nSkill: ${savedSession?.skill?.name ?? "none"}\nLatest run: ${latest?.status ?? "none"}`;
  });

const handleControl = (
  context: GatewayContext,
  controls: Controls,
  entry: Inbox,
  message: IncomingMessage,
  conversation: string,
  session: string,
) =>
  Effect.gen(function* () {
    yield* mark(context, message, "working");
    const reply = yield* controlReply(context, controls, entry, message, conversation, session);
    yield* finish(context, entry.id, reply);
    yield* mark(context, message, "completed");
  });

export const accept = (context: GatewayContext, controls: Controls, input: IncomingMessage) =>
  Effect.gen(function* () {
    const { channel, repo } = context;
    const account = yield* channel.accountId;

    const message = yield* Schema.decodeUnknownEffect(IncomingMessage)(input).pipe(
      Effect.mapError(
        () => new ChannelError({ reason: "configuration", message: "Invalid incoming message." }),
      ),
    );

    if (
      !authorized(channel.policy, message) ||
      (!message.text.trim() && (message.attachments ?? []).length === 0)
    )
      return;
    const conversation = message.conversationId;

    const session =
      conversation === null
        ? null
        : yield* repo.binding(channel.id, account, message.scopeId, conversation);

    if (session === null && !message.mentioned) return;

    const entry = yield* repo.accept(channel.id, account, message);

    if (entry === null) return;
    yield* wake(context.wakes.inbox);

    if (!isControl(message.text)) return;
    yield* repo.state(entry.id, "cancelled");

    if (conversation === null || session === null) return;
    yield* handleControl(context, controls, entry, message, conversation, session);
  });
