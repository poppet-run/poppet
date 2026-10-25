import { Effect, Fiber, Schema } from "effect";

import type { CommandApprovals } from "#src/approvals";
import { ChannelError, IncomingMessage } from "#src/channel";
import {
  authorized,
  finish,
  mark,
  wake,
  type GatewayContext,
  type RunningRequest,
} from "#src/context";
import { gatewayStorage, type Inbox } from "#src/repository";
import { isCommandApproval, isControl } from "#src/request";

/** What control commands act on: pending approvals and the running request. */
export interface Controls {
  readonly approvals: CommandApprovals;
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

    if (isCommandApproval(message.text)) {
      yield* channel.checkAccess(message, conversation);

      return yield* controls.approvals.answer(conversation, message.text);
    }

    if (message.text === "/cancel") {
      const { requests, claims } = controls.running;

      yield* claims.withPermit(
        Effect.gen(function* () {
          yield* gatewayStorage(repo.cancel(channel.id, entry.account, conversation));

          for (const request of requests.values())
            if (request.entry.conversationId === conversation) {
              yield* gatewayStorage(repo.state(request.entry.id, "cancelled"));
              yield* Fiber.interrupt(request.fiber);
            }
        }),
      );

      return "Cancelled this thread's queued and active request.";
    }

    const latestId = (yield* store.messages(session)).at(-1)?.runId;
    const latest = latestId ? yield* store.run(latestId) : null;
    const savedSession = yield* store.session(session);

    return `Session: ${session}\nTitle: ${savedSession?.title ?? session}\nSkill: ${savedSession?.skill?.name ?? "none"}\nLatest run: ${latest?.status ?? "none"}`;
  });

/** Answers /status, /cancel, or an approval reply in a bound conversation without the model. */
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

/** Validates and deduplicates authorized input; status and cancellation bypass inference. */
export const accept = (context: GatewayContext, controls: Controls, input: IncomingMessage) =>
  Effect.gen(function* () {
    const { channel, repo } = context;
    const account = yield* channel.accountId;

    const message = yield* Schema.decodeUnknownEffect(IncomingMessage)(input).pipe(
      Effect.mapError(
        () => new ChannelError({ reason: "configuration", message: "Invalid incoming message." }),
      ),
    );

    if (!authorized(channel.policy, message) || !message.text.trim()) return;
    const conversation = message.conversationId;

    const session =
      conversation === null
        ? null
        : yield* gatewayStorage(repo.binding(channel.id, account, message.scopeId, conversation));

    if (session === null && !message.mentioned) return;

    const entry = yield* gatewayStorage(repo.accept(channel.id, account, message));

    if (entry === null) return;
    yield* wake(context.wakes.inbox);

    if (!isControl(message.text)) return;
    // Controls never create sessions or wait behind the model they may need to cancel.
    yield* gatewayStorage(repo.state(entry.id, "cancelled"));

    if (conversation === null || session === null) return;
    yield* handleControl(context, controls, entry, message, conversation, session);
  });
