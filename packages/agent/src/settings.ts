import { timeZone } from "@poppet/config";
import { limit, limitSettings } from "@poppet/io";
import { savedFactsBytes } from "@poppet/memory";
import { Config, Context, Effect, Layer, Record, Schema, Struct } from "effect";

const chatLimits = Struct.pick(limitSettings, [
  "contextBytes",
  "historyTurns",
  "modelTurns",
  "toolCalls",
  "toolBytes",
  "soulBytes",
  "profileBytes",
  "skillIndexBytes",
  "skillIndexEntries",
  "skillDescriptionBytes",
  "skillMentions",
  "attachmentsPerMessage",
  "imageBytes",
  "textFileBytes",
  "imagesPerRequest",
  "imageContextBytes",
  "pageBytes",
]);

type ChatLimits = { readonly [K in keyof typeof chatLimits]: number };

export interface ChatPolicy extends ChatLimits {
  readonly logReasoning: boolean;
  readonly logTimings: boolean;
  readonly outputTokens: number;
  readonly factsBytes: number;
  readonly runDeadlineSeconds: number;
  readonly maxConcurrentRequests: number;
  readonly timeZone: string | null;
}

export class ChatSettings extends Context.Service<ChatSettings, ChatPolicy>()(
  "poppet/ChatSettings",
) {}

export const defaultPolicy: ChatPolicy = {
  ...Record.map(chatLimits, (value) => value.fallback),
  logReasoning: false,
  logTimings: false,
  outputTokens: 2048,
  factsBytes: savedFactsBytes,
  runDeadlineSeconds: 300,
  maxConcurrentRequests: 3,
  timeZone: null,
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
        outputTokens: Config.schema(bounded(32_768), "outputTokens").pipe(
          Config.withDefault(defaultPolicy.outputTokens),
        ),
        runDeadlineSeconds: Config.schema(
          Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 3600 })),
          "runDeadlineSeconds",
        ).pipe(Config.withDefault(defaultPolicy.runDeadlineSeconds)),
        maxConcurrentRequests: Config.schema(bounded(8), "maxConcurrentRequests").pipe(
          Config.withDefault(defaultPolicy.maxConcurrentRequests),
        ),
        timeZone,
        ...Record.map(chatLimits, (_, name) => limit(name)),
      },
      { concurrency: 1 },
    ).pipe(Effect.map((settings): ChatPolicy => ({ ...defaultPolicy, ...settings }))),
  ),
);
