import type { StoreError } from "@poppet/store";
import { Effect, Fiber, Result, Schema } from "effect";

import { GatewayError, IncomingMessage } from "#src/adapter";
import type { ActionApprovals } from "#src/approvals";
import { authorized, finish, mark, wake } from "#src/context";
import type { GatewayContext, RunningRequest } from "#src/context";
import type { Inbox } from "#src/repository";
import { isApprovalReply, isControl } from "#src/request";

export interface Controls {
  readonly approvals: ActionApprovals;
  readonly running: RunningRequest;
  readonly scheduleControl?: (
    effect: Effect.Effect<void, GatewayError | StoreError>,
  ) => Effect.Effect<void>;
}

const controlReply = (
  context: GatewayContext,
  controls: Controls,
  entry: Inbox,
  message: IncomingMessage,
  conversation: string,
  session: string | null,
) =>
  Effect.gen(function* () {
    const { adapter, repo, store } = context;

    if (isApprovalReply(message.text)) {
      yield* adapter.checkAccess(message, conversation);

      return yield* controls.approvals.answer(conversation, message);
    }

    if (session === null) {
      return yield* Effect.die(new Error("A non-approval control ran without a session."));
    }

    if (message.text.trim() === "/cancel") {
      const { requests, claims } = controls.running;

      yield* claims.withPermit(
        Effect.gen(function* () {
          for (const runId of yield* repo.cancel(
            adapter.id,
            entry.account,
            message.scopeId,
            conversation,
            entry.id,
          )) {
            yield* controls.approvals.end(runId, "cancelled");
          }

          for (const request of requests.values()) {
            if (
              request.entry.id < entry.id &&
              request.entry.account === entry.account &&
              request.entry.message.scopeId === message.scopeId &&
              request.entry.conversationId === conversation
            ) {
              yield* repo.state(request.entry.id, "cancelled");
              yield* Fiber.interrupt(request.fiber);
            }
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
  session: string | null,
) =>
  Effect.gen(function* () {
    yield* mark(context, message, "working");

    const outcome = yield* controlReply(
      context,
      controls,
      entry,
      message,
      conversation,
      session,
    ).pipe(Effect.result);

    if (Result.isFailure(outcome)) {
      if (outcome.failure instanceof GatewayError) {
        yield* finish(context, entry.id, outcome.failure.message, "failed");
      }

      yield* mark(context, message, "stopped");

      return yield* Effect.fail(outcome.failure);
    }

    yield* finish(context, entry.id, outcome.success);
    yield* mark(context, message, "completed");
  }).pipe(Effect.onInterrupt(() => mark(context, message, "stopped")));

export const accept = (context: GatewayContext, controls: Controls, input: IncomingMessage) =>
  Effect.gen(function* () {
    const { adapter, repo } = context;
    const account = yield* adapter.accountId;

    const message = yield* Schema.decodeUnknownEffect(IncomingMessage)(input).pipe(
      Effect.mapError(
        () => new GatewayError({ reason: "configuration", message: "Invalid incoming message." }),
      ),
    );

    if (
      !authorized(adapter.policy, message) ||
      (!message.text.trim() && (message.attachments ?? []).length === 0)
    ) {
      return;
    }

    const conversation = message.conversationId;

    const session =
      conversation === null
        ? null
        : yield* repo.binding(adapter.id, account, message.scopeId, conversation);

    const approvalReply = conversation !== null && isApprovalReply(message.text);

    if (session === null && !message.mentioned && !approvalReply) {
      return;
    }

    const entry = yield* repo.accept(adapter.id, account, message);

    if (entry === null) {
      return;
    }

    if (!isControl(message.text)) {
      yield* wake(context.wakes.inbox);

      return;
    }

    if (conversation === null || (session === null && !approvalReply)) {
      return;
    }

    const control = handleControl(context, controls, entry, message, conversation, session);

    yield* controls.scheduleControl ? controls.scheduleControl(control) : control;
  });
