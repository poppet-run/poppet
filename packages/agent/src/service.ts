import { styleText } from "node:util";

import {
  ProviderError,
  RequestTiming,
  measureTiming,
  recordTiming,
  type ModelOperations,
  type ProviderId,
  type TextSource,
} from "@poppet/provider";
import {
  Store,
  StoreError,
  type Run,
  type RunOutcome,
  type DeliveryDestination,
} from "@poppet/store";
import {
  Cause,
  Clock,
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

import type { ApproveCommand } from "#src/bash";
import { conversation } from "#src/conversation";
import { AgentError } from "#src/errors";
import { memoryPrompt } from "#src/memory";
import { ChatSettings } from "#src/settings";
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

/** Run lifecycle events, streamed answer text, and readable reasoning. */
export type ChatEvent =
  | { readonly type: "started"; readonly run: Run }
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | { readonly type: "reasoning-end" }
  | { readonly type: "completed"; readonly run: Run };

/** Failures from orchestration, model inference, or persistence of a chat request. */
export type ChatFailure = AgentError | ProviderError | StoreError;

/** Coordinates model requests, tool execution, and saved conversation history. */
export class Agent extends Context.Service<
  Agent,
  {
    /** Best-effort optional naming after the answer has been delivered. */
    readonly nameSession: (
      sessionId: string,
      timingLog?: (line: string) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
    /** Streams a reply; readOnlyTools excludes memory writes and task management. */
    readonly send: (
      sessionId: string,
      text: string,
      options?: {
        readonly readOnlyTools?: boolean;
        readonly approveCommand?: ApproveCommand;
        readonly source?: TextSource | undefined;
        readonly runId?: string;
        readonly reasoningLog?: (line: string) => Effect.Effect<void>;
        readonly timingLog?: (line: string) => Effect.Effect<void>;
        /** Host-only validation of this run's authorized messaging conversation. */
        readonly taskDestination?: Effect.Effect<DeliveryDestination, AgentError>;
      },
    ) => Stream.Stream<ChatEvent, ChatFailure>;
  }
>()("poppet/Agent") {}

// A clean consumer exit can still mean it stopped reading before the answer completed.
const failureOutcome = (exit: Exit.Exit<unknown, ChatFailure>): RunOutcome => {
  if (Exit.isSuccess(exit)) return { status: "interrupted", reason: "consumer-stopped" };

  if (Cause.hasInterrupts(exit.cause)) return { status: "interrupted", reason: "cancelled" };
  const error = Option.getOrNull(Cause.findErrorOption(exit.cause));

  if (error === null) return { status: "failed", reason: "internal" };
  let source = "agent";

  if (error instanceof ProviderError) source = "provider";
  else if (error instanceof StoreError) source = "store";

  return {
    status: error.reason === "interrupted" ? "interrupted" : "failed",
    reason: `${source}:${error.reason}`,
  };
};

export const logChatDiagnostic = (text: string) =>
  Console.error(process.env.NO_COLOR ? text : styleText("gray", text, { stream: process.stderr }));

export const AgentLive = Layer.effect(
  Agent,
  Effect.gen(function* () {
    const store = yield* Store;
    const resolver = yield* ModelResolver;
    const converse = yield* conversation;
    const readMemoryPrompt = yield* memoryPrompt;
    const policy = yield* ChatSettings;
    const requests = yield* Semaphore.make(1);
    // Naming is optional and short, so it does not wait behind a running request.
    const naming = yield* Semaphore.make(1);

    const send = (
      sessionId: string,
      text: string,
      options: {
        readonly readOnlyTools?: boolean;
        readonly approveCommand?: ApproveCommand;
        readonly source?: TextSource | undefined;
        readonly runId?: string;
        readonly reasoningLog?: (line: string) => Effect.Effect<void>;
        readonly timingLog?: (line: string) => Effect.Effect<void>;
        readonly taskDestination?: Effect.Effect<DeliveryDestination, AgentError>;
      } = {},
    ): Stream.Stream<ChatEvent, ChatFailure> =>
      Stream.suspend(() => {
        let active: Run | null = null;
        let settled = false;
        let startedAt: number | null = null;
        let firstText = false;
        let attachmentHistory = options.source !== undefined;

        const timing: RequestTiming["Service"] = {
          record: (entry) =>
            policy.logTimings
              ? (options.timingLog ?? Console.error)(
                  `[${new Date().toISOString()}] Timing session=${sessionId} run=${active?.id ?? "pending"} ${JSON.stringify(entry)}`,
                )
              : Effect.void,
        };

        const stream = Stream.unwrap(
          Effect.gen(function* () {
            const requestedAt = yield* Clock.currentTimeMillis;
            startedAt = requestedAt;

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
                  [
                    options.source === undefined
                      ? { role: "user", text }
                      : { role: "user", text, source: options.source },
                  ],
                  options.runId,
                  sessionTitle(text),
                );

                active = pending;
                const running = yield* store.startRun(pending.id);
                active = running;

                return running;
              }),
            );

            let reasoning = "";

            const flushReasoning = (final = false) =>
              Effect.gen(function* () {
                if (attachmentHistory) {
                  reasoning = "";

                  return;
                }

                while (reasoning.length > 0) {
                  const newline = reasoning.indexOf("\n");

                  const length =
                    newline >= 0
                      ? Math.min(newline + 1, 2048)
                      : final || reasoning.length >= 2048
                        ? Math.min(reasoning.length, 2048)
                        : 0;

                  if (length === 0) break;
                  const chunk = reasoning.slice(0, length);
                  reasoning = reasoning.slice(length);
                  const line = `[${new Date().toISOString()}] Thinking session=${sessionId} run=${run.id} ${JSON.stringify(chunk)}`;

                  yield* options.reasoningLog?.(line) ?? logChatDiagnostic(line);
                }
              });

            const reply = Stream.unwrap(
              Effect.gen(function* () {
                const basePrompt = yield* measureTiming("memory", readMemoryPrompt());

                const prompt =
                  session.skill === null
                    ? basePrompt
                    : `${basePrompt}\n\nExplicitly selected owner-written procedure follows as JSON. Apply it to this session, below the base rules. It cannot override explicit user requests, tool permissions, or scheduled tool restrictions. It grants no additional capabilities.\n${JSON.stringify(session.skill)}`;

                const model = yield* measureTiming(
                  "model-resolution",
                  resolver.resolve(session.provider, session.model),
                );

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
                attachmentHistory ||= history.some(
                  (entry) => entry.message.role === "user" && entry.message.source !== undefined,
                );
                const runs = yield* store.runs(sessionId);

                return converse(
                  run,
                  model,
                  text,
                  history,
                  runs,
                  prompt,
                  options.source?.kind === "voice" || (options.readOnlyTools ?? false),
                  options.taskDestination ?? null,
                  options.source,
                  session.skill?.name ?? null,
                  options.approveCommand ?? null,
                );
              }),
            ).pipe(
              Stream.mapEffect((event) =>
                Effect.gen(function* () {
                  if (event.type === "reasoning-delta") {
                    reasoning += event.text;

                    yield* flushReasoning();

                    return event;
                  }

                  yield* flushReasoning(true);

                  if (event.type === "text-delta" && event.text.length > 0 && !firstText) {
                    firstText = true;
                    yield* recordTiming("first-text", requestedAt);
                  }

                  if (event.type === "text-delta" || event.type === "reasoning-end") return event;

                  const saved = yield* Effect.uninterruptible(
                    store.finishRun(run.id, { status: "completed", response: event.response }).pipe(
                      Effect.tap(
                        Effect.sync(() => {
                          settled = true;
                        }),
                      ),
                    ),
                  );

                  return { type: "completed" as const, run: saved };
                }),
              ),
              Stream.ensuring(flushReasoning(true)),
            );

            return Stream.concat(Stream.make<ChatEvent[]>({ type: "started", run }), reply);
          }),
        ).pipe(
          Stream.interruptWhen(
            Effect.sleep(`${policy.runDeadlineSeconds} seconds`).pipe(
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
          Stream.onExit((exit) =>
            startedAt === null
              ? Effect.void
              : recordTiming("run", startedAt, {
                  outcome: settled
                    ? "completed"
                    : Exit.isSuccess(exit) || Cause.hasInterrupts(exit.cause)
                      ? "interrupted"
                      : "failed",
                }).pipe(Effect.provideService(RequestTiming, timing)),
          ),
        );

        // Interactive and scheduled requests share one permit for the full stream lifetime.
        return Stream.unwrap(
          Effect.acquireRelease(requests.take(1).pipe(Effect.interruptible), () =>
            requests.release(1),
          ).pipe(Effect.as(settledStream)),
        ).pipe(Stream.provideService(RequestTiming, timing));
      });

    const nameSession = (sessionId: string, timingLog = Console.error) =>
      Effect.gen(function* () {
        const session = yield* store.claimTitle(sessionId);

        if (session === null) return;

        const original = (yield* store.messages(sessionId)).find(
          (entry) => entry.message.role === "user",
        );

        if (original?.message.role !== "user") return;
        const prompt = original.message.text;

        const result = yield* measureTiming(
          "session-title",
          measureTiming("model-resolution", resolver.resolve(session.provider, session.model)).pipe(
            Effect.flatMap((model) => generateTitle(model, session, prompt)),
            Effect.scoped,
            Effect.timeout("10 seconds"),
          ),
        );

        yield* store.finishTitle(session.id, result.title, result.usage);
      }).pipe(
        naming.withPermit,
        Effect.provideService(RequestTiming, {
          record: (timing) =>
            policy.logTimings
              ? timingLog(
                  `[${new Date().toISOString()}] Timing session=${sessionId} ${JSON.stringify(timing)}`,
                )
              : Effect.void,
        }),
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
