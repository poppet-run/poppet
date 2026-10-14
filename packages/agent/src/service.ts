import { ProviderError, type ModelOperations, type ProviderId } from "@poppet/provider";
import { Store, StoreError, type Run, type RunOutcome } from "@poppet/store";
import { Cause, Context, Effect, Exit, Layer, Option, Stream, type Scope } from "effect";

import { conversation } from "#src/conversation";
import { AgentError } from "#src/errors";

// The host resolves registrations while the request's scope remains open.
export class ModelResolver extends Context.Service<
  ModelResolver,
  {
    readonly resolve: (
      provider: ProviderId,
      model: string,
    ) => Effect.Effect<ModelOperations, ProviderError, Scope.Scope>;
  }
>()("poppet/ModelResolver") {}

export type ChatEvent =
  | { readonly type: "started"; readonly run: Run }
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "completed"; readonly run: Run };

export type ChatFailure = AgentError | ProviderError | StoreError;

export class Agent extends Context.Service<
  Agent,
  {
    readonly send: (sessionId: string, text: string) => Stream.Stream<ChatEvent, ChatFailure>;
  }
>()("poppet/Agent") {}

const failureOutcome = (exit: Exit.Exit<unknown, ChatFailure>): RunOutcome => {
  if (Exit.isSuccess(exit)) return { status: "interrupted", reason: "consumer-stopped" };

  if (Cause.hasInterrupts(exit.cause)) return { status: "interrupted", reason: "cancelled" };
  const failure = Cause.findErrorOption(exit.cause);

  if (Option.isNone(failure)) return { status: "failed", reason: "internal" };
  const error = failure.value;
  let source = "agent";

  if (error instanceof ProviderError) source = "provider";
  else if (error instanceof StoreError) source = "store";

  return {
    status: error.reason === "interrupted" ? "interrupted" : "failed",
    reason: `${source}:${error.reason}`,
  };
};

export const AgentLive = Layer.effect(
  Agent,
  Effect.gen(function* () {
    const store = yield* Store;
    const resolver = yield* ModelResolver;
    const converse = yield* conversation;

    const send = (sessionId: string, text: string): Stream.Stream<ChatEvent, ChatFailure> =>
      Stream.suspend(() => {
        let active: Run | null = null;
        let settled = false;

        const stream = Stream.unwrap(
          Effect.gen(function* () {
            if (text.trim().length === 0)
              return yield* Effect.fail(
                new AgentError({ reason: "invalid-request", message: "Enter a nonempty message." }),
              );
            const session = yield* store.session(sessionId);

            if (session === null)
              return yield* Effect.fail(
                new AgentError({
                  reason: "invalid-request",
                  message: "The session does not exist. Use chat sessions to find a session.",
                }),
              );

            const run = yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const pending = yield* store.queueRun(sessionId, [{ role: "user", text }]);
                active = pending;
                const running = yield* store.startRun(pending.id);
                active = running;

                return running;
              }),
            );

            const reply = Stream.unwrap(
              Effect.gen(function* () {
                const model = yield* resolver.resolve(session.provider, session.model);

                if (
                  model.description.provider !== session.provider ||
                  model.description.id !== session.model
                )
                  return yield* Effect.fail(
                    new AgentError({
                      reason: "invalid-request",
                      message:
                        "The resolved model does not match this session. No fallback is allowed.",
                    }),
                  );
                const history = yield* store.messages(sessionId);
                const runs = yield* store.runs(sessionId);

                return converse(run, model, text, history, runs);
              }),
            ).pipe(
              Stream.mapEffect((event) => {
                if (event.type === "text-delta") return Effect.succeed(event);

                return Effect.uninterruptible(
                  store.finishRun(run.id, { status: "completed", response: event.response }).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        settled = true;
                      }),
                    ),
                    Effect.map((saved): ChatEvent => ({ type: "completed", run: saved })),
                  ),
                );
              }),
            );

            return Stream.concat(Stream.make({ type: "started" as const, run }), reply);
          }),
        ).pipe(
          Stream.interruptWhen(
            Effect.sleep("90 seconds").pipe(
              Effect.andThen(
                Effect.fail(
                  new AgentError({
                    reason: "interrupted",
                    message: "The chat request deadline expired.",
                  }),
                ),
              ),
            ),
          ),
        );

        return stream.pipe(
          Stream.onExit((exit) =>
            active === null || settled
              ? Effect.void
              : store.finishRun(active.id, failureOutcome(exit)).pipe(Effect.asVoid, Effect.orDie),
          ),
        );
      });

    return { send };
  }),
);
