import { styleText } from "node:util";

import { formatLogLine, timeout, writeDiagnostic } from "@poppet/io";
import { ProviderError, RequestTiming, measureTiming, recordTiming } from "@poppet/provider";
import type { AttachmentReference, ModelOperations, ProviderId } from "@poppet/provider";
import { Store, StoreError } from "@poppet/store";
import type { Approval, Run, RunOutcome, Session, SkillSnapshot } from "@poppet/store";
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
} from "effect";
import type { Schema, Scope } from "effect";

import type { ApproveAction } from "#src/action-approval";
import type { RunContext } from "#src/agent-tool";
import { prepareAttachments } from "#src/attachments";
import type { AttachmentInput } from "#src/attachments";
import { conversation } from "#src/conversation";
import { AgentError } from "#src/errors";
import { memoryPrompt } from "#src/memory";
import { ChatSettings } from "#src/settings";
import { loadMentionedSkills } from "#src/skill-mentions";
import { Skills, skillAuthorityRule } from "#src/skills";
import { generateTitle, sessionTitle } from "#src/title";

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
  | { readonly type: "reasoning-delta"; readonly text: string }
  | { readonly type: "reasoning-end" }
  | { readonly type: "completed"; readonly run: Run }
  | { readonly type: "waiting"; readonly run: Run; readonly approval: Approval };

export type ChatFailure = AgentError | ProviderError | StoreError;

export interface SendOptions {
  readonly origin?: RunContext["origin"];
  readonly approveAction?: ApproveAction;
  // Parks the run for the owner with this route instead of calling approveAction.
  readonly approvalRequester?: Schema.JsonObject;
  readonly runId?: string;
  readonly reasoningLog?: (line: string) => Effect.Effect<void>;
  readonly timingLog?: (line: string) => Effect.Effect<void>;
  readonly here?: RunContext["here"];
  readonly home?: RunContext["home"];
  readonly destination?: RunContext["destination"];
  readonly attachments?: ReadonlyArray<AttachmentInput>;
  readonly taskNote?: RunContext["taskNote"];
}

export class Agent extends Context.Service<
  Agent,
  {
    readonly nameSession: (
      sessionId: string,
      timingLog?: (line: string) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
    readonly send: (
      sessionId: string,
      text: string,
      options?: SendOptions,
    ) => Stream.Stream<ChatEvent, ChatFailure>;
    // Continues a run whose approval the owner has decided.
    readonly resume: (
      runId: string,
      options?: SendOptions,
    ) => Stream.Stream<ChatEvent, ChatFailure>;
  }
>()("poppet/Agent") {}

const selectedSkillGuidance = [
  "## Selected skill",
  [
    "An explicitly selected skill for this session follows as JSON.",
    "Apply it to this session.",
    skillAuthorityRule,
  ].join(" "),
].join("\n");

interface Begun {
  readonly session: Session;
  readonly run: Run;
  readonly text: string;
  readonly references: ReadonlyArray<AttachmentReference>;
  readonly mentionedSkills: ReadonlyArray<SkillSnapshot>;
  readonly resume: Approval | null;
}

const notWaiting = new AgentError({
  reason: "invalid-request",
  message: "This run is not waiting on a decided approval.",
});

const failureOutcome = (exit: Exit.Exit<unknown, ChatFailure>): RunOutcome => {
  if (Exit.isSuccess(exit)) {
    return { status: "interrupted", reason: "consumer-stopped" };
  }

  if (Cause.hasInterrupts(exit.cause)) {
    return { status: "interrupted", reason: "cancelled" };
  }

  const error = Option.getOrNull(Cause.findErrorOption(exit.cause));

  if (error === null) {
    return { status: "failed", reason: "internal" };
  }

  let source = "agent";

  if (error instanceof ProviderError) {
    source = "provider";
  } else if (error instanceof StoreError) {
    source = "store";
  }

  return {
    status: error.reason === "interrupted" ? "interrupted" : "failed",
    reason: `${source}:${error.reason}`,
  };
};

const timingLine = (
  session: string,
  run: string | undefined,
  timing: Parameters<RequestTiming["Service"]["record"]>[0],
) =>
  formatLogLine(new Date(), "info", "timing", {
    session,
    run,
    stage: timing.stage,
    duration_ms: timing.durationMs,
    outcome: timing.outcome,
    cached: timing.cached,
  });

export const logChatDiagnostic = (text: string) =>
  writeDiagnostic(
    process.env.NO_COLOR ? text : styleText("gray", text, { stream: process.stderr }),
  );

export const AgentLive = Layer.effect(
  Agent,
  Effect.gen(function* () {
    const store = yield* Store;
    const resolver = yield* ModelResolver;
    const converse = yield* conversation;
    const readMemoryPrompt = yield* memoryPrompt;
    const policy = yield* ChatSettings;
    const skills = Option.getOrNull(yield* Effect.serviceOption(Skills));
    const requests = yield* Semaphore.make(policy.maxConcurrentRequests);
    const sessions = new Map<string, { readonly permit: Semaphore.Semaphore; users: number }>();

    const sessionPermit = (sessionId: string) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const entry = sessions.get(sessionId) ?? { permit: Semaphore.makeUnsafe(1), users: 0 };
          entry.users++;
          sessions.set(sessionId, entry);

          return entry;
        }),
        (entry) =>
          Effect.sync(() => {
            if (--entry.users === 0) {
              sessions.delete(sessionId);
            }
          }),
      ).pipe(
        Effect.flatMap((entry) =>
          Effect.acquireRelease(entry.permit.take(1).pipe(Effect.interruptible), () =>
            entry.permit.release(1),
          ),
        ),
      );

    const naming = yield* Semaphore.make(1);

    const execute = (
      sessionId: string,
      options: SendOptions,
      begin: (track: (run: Run) => void) => Effect.Effect<Begun, ChatFailure>,
    ): Stream.Stream<ChatEvent, ChatFailure> =>
      Stream.suspend(() => {
        let active: Run | null = null;
        let settled = false;
        let startedAt: number | null = null;
        let firstText = false;

        const timing: RequestTiming["Service"] = {
          record: (entry) =>
            policy.logTimings
              ? (options.timingLog ?? Console.error)(
                  timingLine(sessionId, active?.id ?? "pending", entry),
                )
              : Effect.void,
        };

        const stream = Stream.unwrap(
          Effect.gen(function* () {
            const requestedAt = yield* Clock.currentTimeMillis;
            startedAt = requestedAt;

            const { session, run, text, references, mentionedSkills, resume } = yield* begin(
              (value) => {
                active = value;
              },
            );

            let reasoning = "";

            const flushReasoning = (final = false) =>
              Effect.gen(function* () {
                while (reasoning.length > 0) {
                  const newline = reasoning.indexOf("\n");

                  const length =
                    newline >= 0
                      ? Math.min(newline + 1, 2048)
                      : final || reasoning.length >= 2048
                        ? Math.min(reasoning.length, 2048)
                        : 0;

                  if (length === 0) {
                    break;
                  }

                  const chunk = reasoning.slice(0, length);
                  reasoning = reasoning.slice(length);

                  const line = formatLogLine(new Date(), "info", "thinking", {
                    session: sessionId,
                    run: run.id,
                    text: chunk,
                  });

                  yield* options.reasoningLog?.(line) ?? logChatDiagnostic(line);
                }
              });

            const reply = Stream.unwrap(
              Effect.gen(function* () {
                const basePrompt = yield* measureTiming("memory", readMemoryPrompt());

                const prompt =
                  session.skill === null
                    ? basePrompt
                    : `${basePrompt}\n\n${selectedSkillGuidance}\n${JSON.stringify(session.skill)}`;

                const model = yield* measureTiming(
                  "model-resolution",
                  resolver.resolve(session.provider, session.model),
                );

                if (
                  model.description.provider !== session.provider ||
                  model.description.id !== session.model
                ) {
                  return yield* Effect.fail(
                    new AgentError({
                      reason: "invalid-request",
                      message:
                        "The resolved model does not match this session. No fallback is allowed.",
                    }),
                  );
                }

                if (
                  !model.description.capabilities.images &&
                  references.some((reference) => reference.mediaType !== "text/plain")
                ) {
                  return yield* Effect.fail(
                    new AgentError({
                      reason: "attachment",
                      message: `${model.description.name} does not accept images. Start a new session with a model that does.`,
                    }),
                  );
                }

                const history = yield* store.messages(sessionId);
                const runs = yield* store.runs(sessionId);

                return converse({
                  run,
                  model,
                  text,
                  attachments: references,
                  history,
                  runs,
                  prompt,
                  origin: options.origin ?? "interactive",
                  selectedSkill: session.skill?.name ?? null,
                  mentionedSkills,
                  taskNote: options.taskNote ?? null,
                  approveAction: options.approveAction ?? null,
                  approvalRequester: options.approvalRequester ?? null,
                  resume,
                  here: options.here ?? null,
                  home: options.home ?? null,
                  destination: options.destination ?? null,
                });
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

                  if (event.type === "text-delta" || event.type === "reasoning-end") {
                    return event;
                  }

                  if (event.type === "waiting") {
                    settled = true;

                    return {
                      type: "waiting" as const,
                      run: (yield* store.run(run.id)) ?? run,
                      approval: event.approval,
                    };
                  }

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

            return Stream.concat(Stream.make<Array<ChatEvent>>({ type: "started", run }), reply);
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

        return Stream.unwrap(
          sessionPermit(sessionId).pipe(
            Effect.andThen(
              Effect.acquireRelease(requests.take(1).pipe(Effect.interruptible), () =>
                requests.release(1),
              ),
            ),
            Effect.as(settledStream),
          ),
        ).pipe(Stream.provideService(RequestTiming, timing));
      });

    const send = (sessionId: string, text: string, options: SendOptions = {}) =>
      execute(sessionId, options, (track) =>
        Effect.gen(function* () {
          const files = yield* Effect.try({
            try: () => prepareAttachments(options.attachments ?? [], policy),
            catch: (cause) =>
              cause instanceof AgentError
                ? cause
                : new AgentError({
                    reason: "attachment",
                    message: "Cannot read the attachments.",
                  }),
          });

          if (text.trim().length === 0 && files.references.length === 0) {
            return yield* Effect.fail(
              new AgentError({ reason: "invalid-request", message: "Enter a nonempty message." }),
            );
          }

          const session = yield* store.session(sessionId);

          if (session === null) {
            return yield* Effect.fail(
              new AgentError({
                reason: "invalid-request",
                message: "The session does not exist. Use chat sessions to find a session.",
              }),
            );
          }

          const mentionedSkills =
            skills === null || options.origin === "scheduled"
              ? []
              : yield* loadMentionedSkills(
                  skills,
                  text,
                  session.skill?.name ?? null,
                  policy.skillMentions,
                );

          const run = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const pending = yield* store.queueRun(
                sessionId,
                [
                  {
                    role: "user",
                    text,
                    ...(files.references.length > 0 && { attachments: files.references }),
                    ...(mentionedSkills.length > 0 && { skills: mentionedSkills }),
                  },
                ],
                options.runId,
                sessionTitle(text.trim() || (files.references[0]?.name ?? "")),
                files.attachments,
              );

              track(pending);
              const running = yield* store.startRun(pending.id);
              track(running);

              return running;
            }),
          );

          return {
            session,
            run,
            text,
            references: files.references,
            mentionedSkills,
            resume: null,
          } satisfies Begun;
        }),
      );

    const resume = (runId: string, options: SendOptions = {}) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const saved = yield* store.run(runId);

          if (saved === null) {
            return yield* Effect.fail(notWaiting);
          }

          return execute(saved.sessionId, options, (track) =>
            Effect.gen(function* () {
              const run = yield* store.run(runId);
              const approval = run === null ? null : yield* store.latestApproval(run.id);

              const call =
                run === null || approval === null
                  ? undefined
                  : (yield* store.toolCalls(run.id)).find(
                      (entry) => entry.callId === approval.callId,
                    );

              // Checked under the session permit, so a second resume cannot finish this run.
              if (
                run?.status !== "running" ||
                (approval?.state !== "approved" && approval?.state !== "denied") ||
                call?.status !== "pending"
              ) {
                return yield* Effect.fail(notWaiting);
              }

              const session = yield* store.session(run.sessionId);

              const input = (yield* store.messages(run.sessionId)).find(
                (entry) => entry.runId === run.id && entry.message.role === "user",
              )?.message;

              if (session === null || input?.role !== "user") {
                return yield* Effect.fail(
                  new AgentError({ reason: "history", message: "The waiting run has no input." }),
                );
              }

              track(run);

              return {
                session,
                run,
                text: input.text,
                references: input.attachments ?? [],
                mentionedSkills: input.skills ?? [],
                resume: approval,
              } satisfies Begun;
            }),
          );
        }),
      );

    const nameSession = (sessionId: string, timingLog = Console.error) =>
      Effect.gen(function* () {
        const session = yield* store.claimTitle(sessionId);

        if (session === null) {
          return;
        }

        const original = (yield* store.messages(sessionId)).find(
          (entry) => entry.message.role === "user",
        );

        if (original?.message.role !== "user") {
          return;
        }

        const prompt =
          original.message.text.trim() ||
          (original.message.attachments ?? []).map((reference) => reference.name).join(", ");

        const result = yield* measureTiming(
          "session-title",
          measureTiming("model-resolution", resolver.resolve(session.provider, session.model)).pipe(
            Effect.flatMap((model) => generateTitle(model, session, prompt)),
            Effect.scoped,
            Effect.timeout(yield* timeout("sessionTitleSeconds")),
          ),
        );

        yield* store.finishTitle(session.id, result.title, result.usage);
      }).pipe(
        (effect) => naming.withPermit(effect),
        Effect.provideService(RequestTiming, {
          record: (timing) =>
            policy.logTimings ? timingLog(timingLine(sessionId, undefined, timing)) : Effect.void,
        }),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.void
            : Effect.logWarning("optional session naming failed").pipe(
                Effect.annotateLogs({ session: sessionId }),
              ),
        ),
      );

    return { send, resume, nameSession };
  }),
);
