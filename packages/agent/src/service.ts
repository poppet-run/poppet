import {
  ModelEvent,
  ProviderError,
  type Completion,
  type ModelOperations,
  type ModelRequest,
  type ProviderId,
} from "@poppet/provider";
import { Store, StoreError, type Run, type RunOutcome } from "@poppet/store";
import { Cause, Context, Effect, Exit, Layer, Option, Schema, Stream, type Scope } from "effect";

import { assembleContext, byteSize, instructions, outputBudget } from "#src/context";
import { AgentError } from "#src/errors";
import { ChatSettings } from "#src/settings";

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

const maxTextBytes = 131072;

const maxCompletionBytes = 1048576;

const protocolFailure = () =>
  new AgentError({
    reason: "protocol",
    message:
      "The model returned an invalid completion sequence. Partial output was not saved as an answer.",
  });

const outputLimit = () =>
  new AgentError({
    reason: "output-limit",
    message: "The response exceeded the output size limit.",
  });

const validateCompletion = (response: Completion | null, run: Run, streamed: string) => {
  if (response === null) throw protocolFailure();

  if (response.output.some((part) => part.type === "tool-call"))
    throw new AgentError({
      reason: "tools-unavailable",
      message: "The model requested a tool, but tool execution is not enabled yet.",
    });

  if (response.continuation.provider !== run.provider || response.continuation.model !== run.model)
    throw protocolFailure();

  const finalText = response.output
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");

  if (!finalText.startsWith(streamed)) throw protocolFailure();

  if (byteSize(finalText) > maxTextBytes || byteSize(JSON.stringify(response)) > maxCompletionBytes)
    throw outputLimit();

  return { response, remaining: finalText.slice(streamed.length) };
};

// Forward text immediately, but emit completion only after the source ends cleanly.
const streamReply = (
  model: ModelOperations,
  request: ModelRequest,
  run: Run,
): Stream.Stream<ModelEvent, AgentError | ProviderError> =>
  Stream.suspend(() => {
    let completed: Completion | null = null;
    let streamed = "";
    let streamedBytes = 0;

    const deltas = model.stream(request).pipe(
      Stream.mapEffect((event) =>
        Effect.gen(function* () {
          const decoded = yield* Schema.decodeUnknownEffect(ModelEvent, {
            onExcessProperty: "error",
          })(event).pipe(Effect.mapError(protocolFailure));

          if (completed !== null) return yield* Effect.fail(protocolFailure());

          if (decoded.type === "completed") {
            completed = decoded.response;

            return null;
          }

          streamedBytes += byteSize(decoded.text);

          if (streamedBytes > maxTextBytes) return yield* Effect.fail(outputLimit());
          streamed += decoded.text;

          return decoded;
        }),
      ),
      Stream.filter((event) => event !== null),
    );

    const finish = Stream.fromEffect(
      Effect.try({
        try: () => validateCompletion(completed, run, streamed),
        catch: (cause) => (cause instanceof AgentError ? cause : protocolFailure()),
      }),
    ).pipe(
      Stream.flatMap(({ response, remaining }) => {
        const terminal = Stream.make({ type: "completed" as const, response });

        return remaining.length === 0
          ? terminal
          : Stream.concat(Stream.make({ type: "text-delta" as const, text: remaining }), terminal);
      }),
    );

    return Stream.concat(deltas, finish);
  });

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
    const policy = yield* ChatSettings;

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

                const messages = yield* Effect.try({
                  try: () =>
                    assembleContext(
                      history,
                      runs,
                      { role: "user", text },
                      model.description,
                      policy,
                    ),
                  catch: (cause) =>
                    cause instanceof AgentError
                      ? cause
                      : new AgentError({
                          reason: "history",
                          message: "Could not assemble conversation history.",
                        }),
                });

                const settings = model.description.capabilities.generationSettings.includes(
                  "maxOutputTokens",
                )
                  ? { maxOutputTokens: outputBudget(model.description, policy) }
                  : {};

                return streamReply(
                  model,
                  {
                    sessionId,
                    workload: session.workload,
                    instructions,
                    messages,
                    tools: [],
                    settings,
                  },
                  run,
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
