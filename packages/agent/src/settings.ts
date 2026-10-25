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
  /** Absolute deadline for one chat request, including every model turn and tool call. */
  readonly runDeadlineSeconds: number;
  /** Chat requests that may run at once across messaging, interactive chat, and scheduled runs. */
  readonly maxConcurrentRequests: number;
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
  runDeadlineSeconds: 300,
  maxConcurrentRequests: 1,
};

const bounded = (maximum: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }));

export const ChatSettingsLive = Layer.effect(
  ChatSettings,
  Effect.suspend(() =>
    Effect.all(
      {
        logReasoning: Config.Boolean("logReasoning").pipe(
          Config.withDefault(defaultPolicy.logReasoning),
        ),
        logTimings: Config.Boolean("logTimings").pipe(Config.withDefault(defaultPolicy.logTimings)),
        outputTokens: Config.schema(bounded(32768), "outputTokens").pipe(
          Config.withDefault(defaultPolicy.outputTokens),
        ),
        runDeadlineSeconds: Config.schema(
          Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 3600 })),
          "runDeadlineSeconds",
        ).pipe(Config.withDefault(defaultPolicy.runDeadlineSeconds)),
        maxConcurrentRequests: Config.schema(bounded(8), "maxConcurrentRequests").pipe(
          Config.withDefault(defaultPolicy.maxConcurrentRequests),
        ),
      },
      { concurrency: 1 },
    ).pipe(Effect.map((settings) => Object.assign({}, defaultPolicy, settings))),
  ),
);
