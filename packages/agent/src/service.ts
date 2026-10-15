import { ProviderError, type ModelOperations, type ProviderId } from "@poppet/provider";
import { Store, StoreError, type Run, type RunOutcome } from "@poppet/store";
import {
  Cause,
  Console,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Semaphore,
  Stream,
  type Scope,
} from "effect";

import { conversation } from "#src/conversation";
import { AgentError } from "#src/errors";
import { memoryPrompt } from "#src/memory";
import { generateTitle, sessionTitle } from "#src/title";

/** Resolves registered models through the host while the request's resource scope stays open. */
export class ModelResolver extends Context.Service<
  ModelResolver,
  {
    readonly resolve: (
      provider: ProviderId,
      model: string,
    ) => Effect.Effect<ModelOperations, ProviderError, Scope.Scope>;
  }
>()("poppet/ModelResolver") {}

/** Run lifecycle events and incremental answer text emitted by the agent. */
export type ChatEvent =
  | { readonly type: "started"; readonly run: Run }
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "completed"; readonly run: Run };

/** Failures from orchestration, model inference, or persistence of a chat request. */
export type ChatFailure = AgentError | ProviderError | StoreError;

/** Coordinates model requests, tool execution, and saved conversation history. */
export class Agent extends Context.Service<
  Agent,
  {
    /** Best-effort optional naming after the answer has been delivered. */
    readonly nameSession: (sessionId: string) => Effect.Effect<void>;
    /** Streams a reply into an existing session; execution starts when consumed. */
    readonly send: (
      sessionId: string,
      text: string,
      options?: { readonly readOnlyNotes?: boolean; readonly runId?: string },
    ) => Stream.Stream<ChatEvent, ChatFailure>;
  }
>()("poppet/Agent") {}

// A clean consumer exit can still mean it stopped reading before the answer completed.
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
    const readMemoryPrompt = yield* memoryPrompt;
    const requests = yield* Semaphore.make(1);

    const send = (
      sessionId: string,
      text: string,
      options: { readonly readOnlyNotes?: boolean; readonly runId?: string } = {},
    ): Stream.Stream<ChatEvent, ChatFailure> =>
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

            // Track the saved run before allowing cancellation, so finalization can always settle it.
            const run = yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const pending = yield* store.queueRun(
                  sessionId,
                  [{ role: "user", text }],
                  options.runId,
                  sessionTitle(text),
                );

                active = pending;
                const running = yield* store.startRun(pending.id);
                active = running;

                return running;
              }),
            );

            const reply = Stream.unwrap(
              Effect.gen(function* () {
                const prompt = yield* readMemoryPrompt();
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

                return converse(
                  run,
                  model,
                  text,
                  history,
                  runs,
                  prompt,
                  options.readOnlyNotes ?? false,
                );
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

        // Failure or early stream closure must leave a terminal run instead of stranded work.
        const settledStream = stream.pipe(
          Stream.onExit((exit) =>
            active === null || settled
              ? Effect.void
              : store.finishRun(active.id, failureOutcome(exit)).pipe(Effect.asVoid, Effect.orDie),
          ),
        );

        // Interactive and scheduled requests share one permit for the full stream lifetime.
        return Stream.unwrap(
          Effect.acquireRelease(requests.take(1).pipe(Effect.interruptible), () =>
            requests.release(1),
          ).pipe(Effect.as(settledStream)),
        );
      });

    const nameSession = (sessionId: string) =>
      Effect.gen(function* () {
        const session = yield* store.claimTitle(sessionId);

        if (session === null) return;

        const original = (yield* store.messages(sessionId)).find(
          (entry) => entry.message.role === "user",
        );

        if (original?.message.role !== "user") return;
        const prompt = original.message.text;

        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const model = yield* resolver.resolve(session.provider, session.model);

            return yield* generateTitle(model, session, prompt);
          }),
        ).pipe(Effect.timeout("10 seconds"));

        yield* store.finishTitle(session.id, result.title, result.usage);
      }).pipe(
        requests.withPermit,
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.void
            : Console.error(
                "Optional session naming failed; the saved answer and fallback title are unchanged.",
              ),
        ),
      );

    return { send, nameSession };
  }),
);
