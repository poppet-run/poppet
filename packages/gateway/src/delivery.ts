import { Effect } from "effect";

import { authorized, wake, type GatewayContext } from "#src/context";
import { answer, chunks } from "#src/replies";

// Reconcile saved results rather than rerun inference after a crash or failed send.
const scheduleResults = (context: GatewayContext) =>
  Effect.gen(function* () {
    const { channel, repo, store } = context;
    const account = yield* channel.accountId;
    yield* repo.rejectScheduledDeliveries(channel.id, account);

    for (const item of yield* repo.scheduled(channel.id)) {
      const run = yield* store.run(item.runId);

      if (run?.status !== "completed") continue;
      const destination = item.destination;

      const enabled =
        destination.account === account &&
        destination.ownerId === channel.policy.ownerId &&
        destination.scopeId === channel.policy.scopeId;

      yield* repo.scheduleResult(
        item.id,
        item.runId,
        destination,
        chunks(answer(run), channel.textLimit),
        enabled,
      );
    }
  });

/** Sends the next saved reply chunk without automatically retrying an uncertain delivery. */
export const deliverNext = (context: GatewayContext) =>
  Effect.gen(function* () {
    const { channel, repo, clock } = context;
    const account = yield* channel.accountId;
    yield* scheduleResults(context);

    const delivery = yield* repo.nextDelivery(channel.id, account, clock.currentTimeMillisUnsafe());

    if (delivery === null) return false;
    const entry = yield* repo.item(delivery.inboxId);
    const destination = entry.conversationId;

    if (!authorized(channel.policy, entry.message) || destination === null) {
      yield* repo.deliveryFailed(delivery, "failed", 0);

      return true;
    }

    yield* Effect.gen(function* () {
      yield* channel.checkAccess(entry.message, destination);
      // Commit before the send. An interruption after this point is an uncertain delivery.
      yield* repo.delivering(delivery);

      const id = yield* channel.send(
        destination,
        delivery.text,
        `${entry.id}-${delivery.position}`,
      );

      yield* repo.delivered(delivery, id);
      yield* wake(context.wakes.naming);
    }).pipe(
      Effect.catchTag("ChannelError", (error) =>
        repo.deliveryFailed(
          delivery,
          error.reason === "uncertain"
            ? "uncertain"
            : error.reason === "unavailable" && delivery.attempts < 3
              ? "pending"
              : "failed",
          clock.currentTimeMillisUnsafe() +
            Math.max(1000 * 2 ** delivery.attempts, error.retryAfterMs ?? 0),
        ),
      ),
    );

    return true;
  });
