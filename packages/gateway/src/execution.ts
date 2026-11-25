import { AgentError } from "@poppet/agent";
import type { Agent, ChatFailure } from "@poppet/agent";
import { StoreError } from "@poppet/store";
import { Cause, Deferred, Effect, Exit, Fiber, FiberSet, Option, Stream } from "effect";

import type { GatewayError } from "#src/adapter";
import type { ActionApprovals } from "#src/approvals";
import { authorized, finish, mark, wake } from "#src/context";
import type { GatewayContext, RunningRequest } from "#src/context";
import { resolveDestination } from "#src/destination";
import { failureDecision } from "#src/failure";
import { answer } from "#src/replies";
import type { Inbox } from "#src/repository";
import { prepareSession } from "#src/session";
import type { SessionSetup } from "#src/session";

export interface Execution {
  readonly agent: Agent["Service"];
  readonly setup: SessionSetup;
  readonly approvals: ActionApprovals;
  readonly running: RunningRequest;
}

export const recover = (context: GatewayContext) =>
  Effect.gen(function* () {
    const { adapter, repo, store } = context;
    const account = yield* adapter.accountId;
    yield* repo.recoverDelivery(adapter.id, account);

    for (const entry of yield* repo.executing(adapter.id, account)) {
      const run = yield* store.run(entry.runId);

      if (run === null) {
        yield* repo.state(entry.id, "queued");
        continue;
      }

      const completed = run.status === "completed";
      yield* finish(context, entry.id, answer(run), completed ? "completed" : "failed");
      yield* mark(context, entry.message, completed ? "completed" : "stopped");
    }
  });

const settleFailure = (
  context: GatewayContext,
  entry: Inbox,
  cause: Cause.Cause<ChatFailure | GatewayError>,
) =>
  Effect.gen(function* () {
    const { repo, store, clock } = context;
    yield* mark(context, entry.message, "stopped");

    if (Cause.hasInterrupts(cause)) {
      return;
    }

    const { retryAfterMs, reply } = failureDecision(
      Option.getOrNull(Cause.findErrorOption(cause)),
      entry.attempts,
    );

    if (retryAfterMs !== null && (yield* store.run(entry.runId)) === null) {
      yield* repo.retry(entry, clock.currentTimeMillisUnsafe() + retryAfterMs);

      return;
    }

    const saved = yield* repo.item(entry.id);

    if (reply !== null && saved.conversationId !== null) {
      yield* finish(context, entry.id, reply, "failed");
    } else {
      yield* repo.state(entry.id, "failed");
    }
  });

const execute = (context: GatewayContext, execution: Execution, entry: Inbox) =>
  Effect.gen(function* () {
    const { adapter, store } = context;
    const { agent, approvals, running } = execution;
    yield* mark(context, entry.message, "working");

    const prepared = yield* prepareSession(
      context,
      execution.setup,
      entry,
      (conversation, sessionId) => {
        const own = running.requests.get(entry.id);

        if (own !== undefined) {
          own.entry = {
            ...own.entry,
            conversationId: conversation,
            ...(sessionId !== undefined && { sessionId }),
          };
        }
      },
    );

    if (prepared === null) {
      return;
    }

    const { conversation, session, prompt, attachments } = prepared;

    const taskDestination = (requested: string | null = null) =>
      Effect.gen(function* () {
        if (!authorized(adapter.policy, entry.message)) {
          return yield* Effect.fail(
            new AgentError({
              reason: "tool-permission",
              message: "The current messaging owner is no longer authorized.",
            }),
          );
        }

        return yield* resolveDestination(adapter, requested).pipe(
          Effect.mapError(
            (error) => new AgentError({ reason: "tool-permission", message: error.message }),
          ),
        );
      });

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* adapter.typing(conversation).pipe(
          Effect.catchTag("GatewayError", () => Effect.void),
          Effect.andThen(Effect.sleep("8 seconds")),
          Effect.forever,
          Effect.forkScoped,
        );
        yield* Stream.runDrain(
          agent.send(session.id, prompt, {
            runId: entry.runId,
            attachments,
            approveAction: (request, recordAnswer) =>
              approvals.request(entry.message, conversation, request, recordAnswer),
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

const outcome = (exit: Exit.Exit<void, ChatFailure | GatewayError>) =>
  Effect.gen(function* () {
    if (Exit.isSuccess(exit)) {
      return;
    }

    const failure = Option.getOrNull(Cause.findErrorOption(exit.cause));

    if (Cause.hasDies(exit.cause) || failure instanceof StoreError) {
      return yield* exit;
    }

    yield* Effect.logWarning("messaging request failed or was cancelled");
  });

const claimNext = (
  context: GatewayContext,
  execution: Execution,
  start: (
    request: Effect.Effect<void, ChatFailure | GatewayError>,
  ) => Effect.Effect<Fiber.Fiber<void, ChatFailure | GatewayError>>,
) =>
  execution.running.claims.withPermit(
    Effect.gen(function* () {
      const { adapter, repo, clock } = context;
      const { requests } = execution.running;
      const account = yield* adapter.accountId;

      const entry = yield* repo.next(adapter.id, account, clock.currentTimeMillisUnsafe());

      if (entry === null) {
        return null;
      }

      if (!authorized(adapter.policy, entry.message)) {
        yield* repo.state(entry.id, "cancelled");

        return "skipped" as const;
      }

      if (!(yield* repo.claim(entry.id))) {
        return "skipped" as const;
      }

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

export const processNext = (context: GatewayContext, execution: Execution) =>
  Effect.gen(function* () {
    const fiber = yield* claimNext(context, execution, Effect.forkChild);

    if (fiber === null) {
      return false;
    }

    if (fiber !== "skipped") {
      yield* Fiber.await(fiber).pipe(Effect.flatMap(outcome));
    }

    return true;
  });

export const dispatchNext = (
  context: GatewayContext,
  execution: Execution,
  active: FiberSet.FiberSet<void, ChatFailure | GatewayError>,
  limit: number,
) =>
  Effect.gen(function* () {
    if (execution.running.requests.size >= limit) {
      return false;
    }

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
