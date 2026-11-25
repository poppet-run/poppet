import { isNoReply } from "@poppet/agent";
import { quietHoursEnd } from "@poppet/config";
import { Effect } from "effect";

import { authorized, wake } from "#src/context";
import type { GatewayContext } from "#src/context";
import { gatewayRetryDelay } from "#src/failure";
import { answer, chunks } from "#src/replies";

const scheduleResults = (context: GatewayContext) =>
  Effect.gen(function* () {
    const { adapter, repo, store } = context;
    const account = yield* adapter.accountId;
    yield* repo.rejectScheduledDeliveries(adapter.id, account);

    for (const item of yield* repo.scheduled(adapter.id)) {
      const run = yield* store.run(item.runId);

      if (run?.status !== "completed") {
        continue;
      }

      const destination = item.destination;

      const enabled =
        destination.account === account &&
        destination.ownerId === adapter.policy.ownerId &&
        destination.scopeId === adapter.policy.scopeId;

      const text = answer(run);

      yield* repo.scheduleResult(
        item.id,
        item.runId,
        destination,
        isNoReply(text) ? [] : chunks(text, adapter.textLimit),
        enabled,
      );
    }
  });

const noticeWindow = 24 * 60 * 60 * 1000;

const scheduleFailureNotices = (context: GatewayContext) =>
  Effect.gen(function* () {
    const { adapter, repo, clock } = context;
    const account = yield* adapter.accountId;
    const since = clock.currentTimeMillisUnsafe() - noticeWindow;

    for (const item of yield* repo.failedScheduled(adapter.id, since)) {
      const destination = item.destination;

      const enabled =
        destination.account === account &&
        destination.ownerId === adapter.policy.ownerId &&
        destination.scopeId === adapter.policy.scopeId;

      const text = `Scheduled task "${item.name}" failed (${item.reason}). Inspect it with: poppet tasks show ${item.jobId}`;

      yield* repo.scheduleResult(
        item.id,
        item.noticeId,
        destination,
        item.repeated ? [] : chunks(text, adapter.textLimit),
        enabled,
      );
    }
  });

export const deliverNext = (context: GatewayContext) => {
  let announcedHold: number | null = null;

  return Effect.gen(function* () {
    const { adapter, repo, clock, quietHours } = context;
    const account = yield* adapter.accountId;
    yield* scheduleResults(context);
    yield* scheduleFailureNotices(context);

    const now = clock.currentTimeMillisUnsafe();
    const heldUntil = quietHours === null ? null : quietHoursEnd(quietHours, now);
    // During quiet hours scheduled posts sort last, so one only comes back when nothing else is ready.
    const delivery = yield* repo.nextDelivery(adapter.id, account, now, heldUntil !== null);

    if (delivery === null) {
      return false;
    }

    if (heldUntil !== null && delivery.scheduled) {
      if (announcedHold !== heldUntil) {
        yield* Effect.logInfo(
          `Holding scheduled ${adapter.id} posts for quiet hours until ${new Date(heldUntil).toISOString()}.`,
        );
      }

      announcedHold = heldUntil;

      return false;
    }

    const entry = yield* repo.item(delivery.inboxId);
    const destination = entry.conversationId;

    if (!authorized(adapter.policy, entry.message) || destination === null) {
      yield* repo.deliveryFailed(delivery, "failed", 0);

      return true;
    }

    yield* Effect.gen(function* () {
      yield* adapter.checkAccess(entry.message, destination);
      yield* repo.delivering(delivery);

      yield* Effect.uninterruptibleMask((restore) =>
        restore(adapter.send(destination, delivery.text, `${entry.id}-${delivery.position}`)).pipe(
          Effect.flatMap((id) => repo.delivered(delivery, id)),
        ),
      );
      yield* wake(context.wakes.naming);
    }).pipe(
      Effect.catchTag("GatewayError", (error) => {
        const delay =
          error.reason === "unavailable" ? gatewayRetryDelay(error, delivery.attempts) : null;

        return repo.deliveryFailed(
          delivery,
          error.reason === "uncertain" ? "uncertain" : delay === null ? "failed" : "pending",
          clock.currentTimeMillisUnsafe() + (delay ?? 0),
        );
      }),
    );

    return true;
  });
};
