import { Config, Context, Effect, Layer, Schema } from "effect";

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
  readonly skillIndexBytes: number;
  readonly runDeadlineSeconds: number;
  readonly maxConcurrentRequests: number;
  readonly attachmentsPerMessage: number;
  readonly imageBytes: number;
  readonly textFileBytes: number;
  readonly imagesPerRequest: number;
  readonly imageContextBytes: number;
}

export class ChatSettings extends Context.Service<ChatSettings, ChatPolicy>()(
  "poppet/ChatSettings",
) {}

export const defaultPolicy: ChatPolicy = {
  logReasoning: false,
  logTimings: false,
  contextBytes: 262144,
  historyTurns: 20,
  outputTokens: 2048,
  modelTurns: 16,
  toolCalls: 16,
  toolBytes: 16384,
  soulBytes: 8192,
  profileBytes: 8192,
  factsBytes: 8192,
  skillIndexBytes: 8192,
  runDeadlineSeconds: 300,
  maxConcurrentRequests: 3,
  attachmentsPerMessage: 4,
  imageBytes: 5 * 1024 * 1024,
  textFileBytes: 64 * 1024,
  imagesPerRequest: 8,
  imageContextBytes: 6144,
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
