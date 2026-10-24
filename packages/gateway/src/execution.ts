import { AgentError, type Agent, type ChatFailure } from "@poppet/agent";
import { StoreError } from "@poppet/store";
import { Cause, Console, Effect, Exit, Fiber, Option, Stream } from "effect";

import type { CommandApprovals } from "#src/approvals";
import type { ChannelError } from "#src/channel";
import { authorized, finish, mark, type GatewayContext, type RunningRequest } from "#src/context";
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
    const { channel, repo, store } = context;
    const { agent, approvals, running } = execution;
    yield* mark(context, entry.message, "working");
    const prepared = yield* prepareSession(context, execution.setup, entry);

    if (prepared === null) return;
    const { conversation, session, prompt } = prepared;

    if (running.current !== null)
      running.current.entry = { ...entry, conversationId: conversation, sessionId: session.id };
    yield* gatewayStorage(repo.state(entry.id, "executing"));
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
            home: resolveDestination(channel).pipe(
              Effect.mapError(
                (error) => new AgentError({ reason: "tool-permission", message: error.message }),
              ),
            ),
            here: Effect.gen(function* () {
              if (!authorized(channel.policy, entry.message))
                return yield* Effect.fail(
                  new AgentError({
                    reason: "tool-permission",
                    message: "The current messaging owner is no longer authorized.",
                  }),
                );

              return yield* resolveDestination(channel, conversation).pipe(
                Effect.mapError(
                  (error) => new AgentError({ reason: "tool-permission", message: error.message }),
                ),
              );
            }),
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

/** Executes the next eligible queued request, retrying setup only before a run exists. */
export const processNext = (context: GatewayContext, execution: Execution) =>
  Effect.gen(function* () {
    const { channel, repo, clock } = context;
    const { running } = execution;
    const account = yield* channel.accountId;

    const entry = yield* gatewayStorage(
      repo.next(channel.id, account, clock.currentTimeMillisUnsafe()),
    );

    if (entry === null) return false;

    if (!authorized(channel.policy, entry.message)) {
      yield* gatewayStorage(repo.state(entry.id, "cancelled"));

      return true;
    }

    const fiber = yield* execute(context, execution, entry).pipe(Effect.forkChild);
    running.current = { entry, fiber };

    const result = yield* Fiber.await(fiber).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          running.current = null;
        }),
      ),
    );

    if (Exit.isFailure(result)) {
      const failure = Option.getOrNull(Cause.findErrorOption(result.cause));

      if (Cause.hasDies(result.cause) || failure instanceof StoreError) return yield* result;
      yield* Console.error(
        "Messaging request failed or was cancelled. Inspect gateway status and saved runs.",
      );
    }

    return true;
  });
