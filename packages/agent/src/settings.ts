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
        runDeadlineSeconds: Config.schema(
          Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 3600 })),
          "POPPET_RUN_DEADLINE_SECONDS",
        ).pipe(Config.withDefault(defaultPolicy.runDeadlineSeconds)),
      },
      { concurrency: 1 },
    ),
  ),
);
