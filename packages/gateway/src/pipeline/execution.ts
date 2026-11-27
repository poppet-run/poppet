import { AgentError } from "@poppet/agent";
import type { Agent, ChatFailure } from "@poppet/agent";
import { StoreError } from "@poppet/store";
import { Cause, Deferred, Effect, Exit, Fiber, FiberSet, Option, Stream } from "effect";

import { GatewayError } from "#src/adapter";
import type { ActionApprovals } from "#src/approvals/approvals";
import { resolveDestination } from "#src/destination";
import { authorized, finish, mark, wake } from "#src/pipeline/context";
import type { GatewayContext, RunningRequest } from "#src/pipeline/context";
import { failureDecision } from "#src/pipeline/failure";
import { answer } from "#src/pipeline/replies";
import { prepareSession } from "#src/pipeline/session";
import type { SessionSetup } from "#src/pipeline/session";
import type { Inbox } from "#src/repository";

export interface Execution {
  readonly agent: Agent["Service"];
  readonly setup: SessionSetup;
  readonly approvals: ActionApprovals;
  readonly running: RunningRequest;
}

export const recover = (context: GatewayContext, approvals: ActionApprovals) =>
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

      // A run that survived the store's recovery is waiting or ready to resume.
      if (run.status === "waiting") {
        yield* repo.state(entry.id, "waiting");
        continue;
      }

      if (run.status === "running") {
        yield* repo.state(entry.id, "queued");
        continue;
      }

      const completed = run.status === "completed";
      yield* finish(context, entry.id, answer(run), completed ? "completed" : "failed");
      yield* mark(context, entry.message, completed ? "completed" : "stopped");
    }

    yield* approvals.reconcile;
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

    const error = Option.getOrNull(Cause.findErrorOption(cause));
    const { retryAfterMs, reply } = failureDecision(error, entry.attempts);
    const run = yield* store.run(entry.runId);

    if (retryAfterMs !== null && run === null) {
      yield* repo.retry(entry, clock.currentTimeMillisUnsafe() + retryAfterMs);

      return;
    }

    if (run?.status === "running" || run?.status === "waiting") {
      yield* store.finishRun(entry.runId, {
        status: "failed",
        reason: error instanceof GatewayError ? `gateway:${error.reason}` : "gateway:failed",
      });
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
    const { adapter, repo, store } = context;
    const { agent, approvals, running } = execution;
    yield* mark(context, entry.message, "working");

    // A request whose run already exists is resuming after the owner answered its approval.
    const resuming = (yield* store.run(entry.runId)) !== null;

    const prepared = resuming
      ? null
      : yield* prepareSession(context, execution.setup, entry, (conversation, sessionId) => {
          const own = running.requests.get(entry.id);

          if (own !== undefined) {
            own.entry = {
              ...own.entry,
              conversationId: conversation,
              ...(sessionId !== undefined && { sessionId }),
            };
          }
        });

    if (!resuming && prepared === null) {
      return;
    }

    const conversation = prepared?.conversation ?? entry.conversationId;

    if (conversation === null) {
      return yield* Effect.die(new Error("A resumed request has no conversation."));
    }

    if (resuming) {
      yield* adapter.checkAccess(entry.message, conversation);
    } else if (prepared !== null) {
      yield* approvals.supersede(prepared.session.id);
    }

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

        const options = {
          approvalRequester: {
            surface: "gateway",
            adapter: adapter.id,
            account: entry.account,
            conversationId: conversation,
            inboxId: entry.id,
          },
          home: taskDestination(),
          here: taskDestination(conversation),
          destination: taskDestination,
        };

        yield* Stream.runDrain(
          prepared === null
            ? agent.resume(entry.runId, options)
            : agent.send(prepared.session.id, prepared.prompt, {
                ...options,
                runId: entry.runId,
                attachments: prepared.attachments,
              }),
        );
      }),
    );
    const run = yield* store.run(entry.runId);
    const approval = run?.status === "waiting" ? yield* store.latestApproval(run.id) : null;

    if (approval !== null) {
      yield* repo.state(entry.id, "waiting");
      yield* approvals
        .post(entry, conversation, approval)
        .pipe(
          Effect.catchTag("GatewayError", (error) =>
            Effect.logWarning("approval prompt post failed; will retry on reconcile").pipe(
              Effect.annotateLogs({ error: error.message }),
            ),
          ),
        );
    } else if (run !== null) {
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
