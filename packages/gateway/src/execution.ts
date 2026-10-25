import { AgentError, type Agent, type ChatFailure } from "@poppet/agent";
import { StoreError } from "@poppet/store";
import { Cause, Console, Deferred, Effect, Exit, Fiber, FiberSet, Option, Stream } from "effect";

import type { CommandApprovals } from "#src/approvals";
import type { ChannelError } from "#src/channel";
import {
  authorized,
  finish,
  mark,
  wake,
  type GatewayContext,
  type RunningRequest,
} from "#src/context";
import { resolveDestination } from "#src/destination";
import { failureDecision } from "#src/failure";
import { answer } from "#src/replies";
import { gatewayStorage, type Inbox } from "#src/repository";
import { prepareSession, type SessionSetup } from "#src/session";

/** What executing a request needs beyond the shared context. */
export interface Execution {
  readonly agent: Agent["Service"];
  readonly setup: SessionSetup;
  readonly approvals: CommandApprovals;
  readonly running: RunningRequest;
}

/** Reconciles saved runs with the inbox and leaves interrupted sends uncertain. */
export const recover = (context: GatewayContext) =>
  Effect.gen(function* () {
    const { channel, repo, store } = context;
    const account = yield* channel.accountId;
    yield* gatewayStorage(repo.recoverDelivery(channel.id, account));

    for (const entry of yield* gatewayStorage(repo.executing(channel.id, account))) {
      const run = yield* store.run(entry.runId);

      if (run === null) yield* gatewayStorage(repo.state(entry.id, "queued"));
      else {
        yield* finish(context, entry.id, answer(run));
        yield* mark(context, entry.message, run.status === "completed" ? "completed" : "stopped");
      }
    }
  });

/** Retries setup while no run is saved; otherwise fails the entry, replying when it can. */
const settleFailure = (
  context: GatewayContext,
  entry: Inbox,
  cause: Cause.Cause<ChatFailure | ChannelError>,
) =>
  Effect.gen(function* () {
    const { repo, store, clock } = context;
    yield* mark(context, entry.message, "stopped");

    if (Cause.hasInterrupts(cause)) return;

    const { retryAfterMs, reply } = failureDecision(
      Option.getOrNull(Cause.findErrorOption(cause)),
      entry.attempts,
    );

    if (retryAfterMs !== null && (yield* store.run(entry.runId)) === null) {
      yield* gatewayStorage(repo.retry(entry, clock.currentTimeMillisUnsafe() + retryAfterMs));

      return;
    }

    const saved = yield* gatewayStorage(repo.item(entry.id));

    if (reply !== null && saved.conversationId !== null)
      yield* finish(context, entry.id, reply, "failed");
    else yield* gatewayStorage(repo.state(entry.id, "failed"));
  });

/** Prepares the session, runs the agent with typing shown, and saves the run's answer. */
const execute = (context: GatewayContext, execution: Execution, entry: Inbox) =>
  Effect.gen(function* () {
    const { channel, store } = context;
    const { agent, approvals, running } = execution;
    yield* mark(context, entry.message, "working");
    const prepared = yield* prepareSession(context, execution.setup, entry);

    if (prepared === null) return;
    const { conversation, session, prompt } = prepared;

    const taskDestination = (requested: string | null = null) =>
      Effect.gen(function* () {
        if (!authorized(channel.policy, entry.message))
          return yield* Effect.fail(
            new AgentError({
              reason: "tool-permission",
              message: "The current messaging owner is no longer authorized.",
            }),
          );

        return yield* resolveDestination(channel, requested).pipe(
          Effect.mapError(
            (error) => new AgentError({ reason: "tool-permission", message: error.message }),
          ),
        );
      });

    const own = running.requests.get(entry.id);

    if (own !== undefined)
      own.entry = { ...entry, conversationId: conversation, sessionId: session.id };
    yield* Effect.scoped(
      Effect.gen(function* () {
        // Discord typing expires after ten seconds; progress must never block inference.
        yield* channel.typing(conversation).pipe(
          Effect.catchTag("ChannelError", () => Effect.void),
          Effect.andThen(Effect.sleep("8 seconds")),
          Effect.forever,
          Effect.forkScoped,
        );
        yield* Stream.runDrain(
          agent.send(session.id, prompt, {
            runId: entry.runId,
            approveCommand: (request) => approvals.request(entry.message, conversation, request),
            home: taskDestination(),
            here: taskDestination(conversation),
            destination: taskDestination,
          }),
        );
      }),
    );
    const run = yield* store.run(entry.runId);

    if (run !== null) {
      yield* finish(context, entry.id, answer(run));
      yield* mark(context, entry.message, run.status === "completed" ? "completed" : "stopped");
    }
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit) ? Effect.void : settleFailure(context, entry, exit.cause),
    ),
  );

// Storage failures and defects stop the gateway; other failures were settled with their request.
const outcome = (exit: Exit.Exit<void, ChatFailure | ChannelError>) =>
  Effect.gen(function* () {
    if (Exit.isSuccess(exit)) return;
    const failure = Option.getOrNull(Cause.findErrorOption(exit.cause));

    if (Cause.hasDies(exit.cause) || failure instanceof StoreError) return yield* exit;
    yield* Console.error(
      "Messaging request failed or was cancelled. Inspect gateway status and saved runs.",
    );
  });

/**
 * Claims the next eligible request and starts it with `start`, registered as running before
 * it begins. Returns null when nothing is eligible, or "skipped" for an entry it did not run.
 */
const claimNext = (
  context: GatewayContext,
  execution: Execution,
  start: (
    request: Effect.Effect<void, ChatFailure | ChannelError>,
  ) => Effect.Effect<Fiber.Fiber<void, ChatFailure | ChannelError>>,
) =>
  execution.running.claims.withPermit(
    Effect.gen(function* () {
      const { channel, repo, clock } = context;
      const { requests } = execution.running;
      const account = yield* channel.accountId;

      const entry = yield* gatewayStorage(
        repo.next(channel.id, account, clock.currentTimeMillisUnsafe()),
      );

      if (entry === null) return null;

      if (!authorized(channel.policy, entry.message)) {
        yield* gatewayStorage(repo.state(entry.id, "cancelled"));

        return "skipped" as const;
      }

      if (!(yield* gatewayStorage(repo.claim(entry.id)))) return "skipped" as const;
      const registered = yield* Deferred.make<void>();

      const request = Deferred.await(registered).pipe(
        Effect.andThen(execute(context, execution, entry)),
        Effect.ensuring(
          Effect.sync(() => {
            requests.delete(entry.id);
          }),
        ),
      );

      const fiber = yield* start(request);
      requests.set(entry.id, { entry, fiber });
      yield* Deferred.succeed(registered, undefined);

      return fiber;
    }),
  );

/** Executes the next eligible queued request and waits for it to finish. */
export const processNext = (context: GatewayContext, execution: Execution) =>
  Effect.gen(function* () {
    const fiber = yield* claimNext(context, execution, Effect.forkChild);

    if (fiber === null) return false;

    if (fiber !== "skipped") yield* Fiber.await(fiber).pipe(Effect.flatMap(outcome));

    return true;
  });

/**
 * Starts the next eligible request in `active` while fewer than `limit` are running. Each
 * request wakes the inbox when it ends, so a later request in its conversation can start.
 */
export const dispatchNext = (
  context: GatewayContext,
  execution: Execution,
  active: FiberSet.FiberSet<void, ChatFailure | ChannelError>,
  limit: number,
) =>
  Effect.gen(function* () {
    if (execution.running.requests.size >= limit) return false;

    const claimed = yield* claimNext(context, execution, (request) =>
      FiberSet.run(
        active,
        request.pipe(
          Effect.exit,
          Effect.flatMap(outcome),
          Effect.ensuring(wake(context.wakes.inbox)),
        ),
      ),
    );

    return claimed !== null;
  });
