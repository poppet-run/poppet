import { Config, Context, Effect, Layer, Schema } from "effect";

/** Per-run diagnostics and limits for context, tools, and memory loaded into the prompt. */
export interface ChatPolicy {
  readonly logReasoning: boolean;
  readonly logTimings: boolean;
  readonly contextBytes: number;
  readonly historyTurns: number;
  readonly outputTokens: number;
  readonly modelTurns: number;
  readonly toolCalls: number;
  readonly toolBytes: number;
  readonly soulBytes: number;
  readonly profileBytes: number;
  readonly factsBytes: number;
  /** UTF-8 bytes of the skill index in instructions; zero disables model-selected skills. */
  readonly skillIndexBytes: number;
  /** Lets interactive runs create and change learned skills. */
  readonly learnSkills: boolean;
  /** Lets interactive runs save, replace, and forget facts without an explicit request. */
  readonly learnMemory: boolean;
  /** Queues background review of qualifying interactive runs for the worker. */
  readonly learnReview: boolean;
  /** Tool calls that make a run worth reviewing. */
  readonly reviewMinToolCalls: number;
  /** Completed runs in a session since its last review that make the next one qualify. */
  readonly reviewTurnInterval: number;
  /** UTF-8 bytes of the reviewed run's transcript sent to the review model. */
  readonly reviewInputBytes: number;
  /** Pending reviews older than this are skipped instead of run. */
  readonly reviewMaxAgeHours: number;
  /** Absolute deadline for one chat request, including every model turn and tool call. */
  readonly runDeadlineSeconds: number;
}

/** Supplies validated chat limits shared by context assembly and the tool loop. */
export class ChatSettings extends Context.Service<ChatSettings, ChatPolicy>()(
  "poppet/ChatSettings",
) {}

export const defaultPolicy: ChatPolicy = {
  logReasoning: false,
  logTimings: false,
  contextBytes: 262144,
  historyTurns: 20,
  outputTokens: 2048,
  modelTurns: 8,
  toolCalls: 16,
  toolBytes: 16384,
  soulBytes: 8192,
  profileBytes: 8192,
  factsBytes: 8192,
  skillIndexBytes: 8192,
  learnSkills: false,
  learnMemory: false,
  learnReview: false,
  reviewMinToolCalls: 5,
  reviewTurnInterval: 10,
  reviewInputBytes: 65536,
  reviewMaxAgeHours: 24,
  runDeadlineSeconds: 300,
};

const bounded = (maximum: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }));

export const ChatSettingsLive = Layer.effect(
  ChatSettings,
  Effect.suspend(() =>
    Effect.all(
      {
        logReasoning: Config.Boolean("POPPET_LOG_REASONING").pipe(
          Config.withDefault(defaultPolicy.logReasoning),
        ),
        logTimings: Config.Boolean("POPPET_LOG_TIMINGS").pipe(
          Config.withDefault(defaultPolicy.logTimings),
        ),
        contextBytes: Config.schema(bounded(1048576), "POPPET_CONTEXT_BYTES").pipe(
          Config.withDefault(defaultPolicy.contextBytes),
        ),
        historyTurns: Config.schema(bounded(100), "POPPET_HISTORY_TURNS").pipe(
          Config.withDefault(defaultPolicy.historyTurns),
        ),
        outputTokens: Config.schema(bounded(32768), "POPPET_OUTPUT_TOKENS").pipe(
          Config.withDefault(defaultPolicy.outputTokens),
        ),
        modelTurns: Config.schema(bounded(32), "POPPET_MODEL_TURNS").pipe(
          Config.withDefault(defaultPolicy.modelTurns),
        ),
        toolCalls: Config.schema(bounded(64), "POPPET_TOOL_CALLS").pipe(
          Config.withDefault(defaultPolicy.toolCalls),
        ),
        toolBytes: Config.schema(
          Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65536 })),
          "POPPET_TOOL_BYTES",
        ).pipe(Config.withDefault(defaultPolicy.toolBytes)),
        soulBytes: Config.schema(bounded(65536), "POPPET_SOUL_BYTES").pipe(
          Config.withDefault(defaultPolicy.soulBytes),
        ),
        profileBytes: Config.schema(bounded(65536), "POPPET_PROFILE_BYTES").pipe(
          Config.withDefault(defaultPolicy.profileBytes),
        ),
        factsBytes: Config.schema(bounded(65536), "POPPET_FACTS_BYTES").pipe(
          Config.withDefault(defaultPolicy.factsBytes),
        ),
        skillIndexBytes: Config.schema(
          Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65536 })),
          "POPPET_SKILL_INDEX_BYTES",
        ).pipe(Config.withDefault(defaultPolicy.skillIndexBytes)),
        learnSkills: Config.Boolean("POPPET_LEARN_SKILLS").pipe(
          Config.withDefault(defaultPolicy.learnSkills),
        ),
        learnMemory: Config.Boolean("POPPET_LEARN_MEMORY").pipe(
          Config.withDefault(defaultPolicy.learnMemory),
        ),
        learnReview: Config.Boolean("POPPET_LEARN_REVIEW").pipe(
          Config.withDefault(defaultPolicy.learnReview),
        ),
        reviewMinToolCalls: Config.schema(bounded(64), "POPPET_REVIEW_MIN_TOOL_CALLS").pipe(
          Config.withDefault(defaultPolicy.reviewMinToolCalls),
        ),
        reviewTurnInterval: Config.schema(bounded(100), "POPPET_REVIEW_TURN_INTERVAL").pipe(
          Config.withDefault(defaultPolicy.reviewTurnInterval),
        ),
        reviewInputBytes: Config.schema(
          Schema.Int.check(Schema.isBetween({ minimum: 4096, maximum: 262144 })),
          "POPPET_REVIEW_INPUT_BYTES",
        ).pipe(Config.withDefault(defaultPolicy.reviewInputBytes)),
        reviewMaxAgeHours: Config.schema(bounded(168), "POPPET_REVIEW_MAX_AGE_HOURS").pipe(
          Config.withDefault(defaultPolicy.reviewMaxAgeHours),
        ),
        runDeadlineSeconds: Config.schema(
          Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 3600 })),
          "POPPET_RUN_DEADLINE_SECONDS",
        ).pipe(Config.withDefault(defaultPolicy.runDeadlineSeconds)),
      },
      { concurrency: 1 },
    ),
  ),
);
