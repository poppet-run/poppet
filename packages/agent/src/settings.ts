import { Config, ConfigProvider, Context, Effect, Layer, Schema } from "effect";

export interface ChatPolicy {
  readonly contextBytes: number;
  readonly historyTurns: number;
  readonly outputTokens: number;
  readonly modelTurns: number;
  readonly toolCalls: number;
  readonly toolBytes: number;
  readonly soulBytes: number;
  readonly profileBytes: number;
  readonly factsBytes: number;
}

export class ChatSettings extends Context.Service<ChatSettings, ChatPolicy>()(
  "poppet/ChatSettings",
) {}

export const defaultPolicy: ChatPolicy = {
  contextBytes: 65536,
  historyTurns: 20,
  outputTokens: 2048,
  modelTurns: 8,
  toolCalls: 16,
  toolBytes: 16384,
  soulBytes: 8192,
  profileBytes: 8192,
  factsBytes: 8192,
};

const bounded = (maximum: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }));

export const ChatSettingsLive = Layer.effect(
  ChatSettings,
  Effect.gen(function* () {
    const contextBytes = yield* Config.schema(bounded(1048576), "POPPET_CONTEXT_BYTES").pipe(
      Config.withDefault(defaultPolicy.contextBytes),
    );

    const historyTurns = yield* Config.schema(bounded(100), "POPPET_HISTORY_TURNS").pipe(
      Config.withDefault(defaultPolicy.historyTurns),
    );

    const outputTokens = yield* Config.schema(bounded(32768), "POPPET_OUTPUT_TOKENS").pipe(
      Config.withDefault(defaultPolicy.outputTokens),
    );

    const modelTurns = yield* Config.schema(bounded(32), "POPPET_MODEL_TURNS").pipe(
      Config.withDefault(defaultPolicy.modelTurns),
    );

    const toolCalls = yield* Config.schema(bounded(64), "POPPET_TOOL_CALLS").pipe(
      Config.withDefault(defaultPolicy.toolCalls),
    );

    const toolBytes = yield* Config.schema(
      Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65536 })),
      "POPPET_TOOL_BYTES",
    ).pipe(Config.withDefault(defaultPolicy.toolBytes));

    const soulBytes = yield* Config.schema(bounded(65536), "POPPET_SOUL_BYTES").pipe(
      Config.withDefault(defaultPolicy.soulBytes),
    );

    const profileBytes = yield* Config.schema(bounded(65536), "POPPET_PROFILE_BYTES").pipe(
      Config.withDefault(defaultPolicy.profileBytes),
    );

    const factsBytes = yield* Config.schema(bounded(65536), "POPPET_FACTS_BYTES").pipe(
      Config.withDefault(defaultPolicy.factsBytes),
    );

    return {
      contextBytes,
      historyTurns,
      outputTokens,
      modelTurns,
      toolCalls,
      toolBytes,
      soulBytes,
      profileBytes,
      factsBytes,
    };
  }),
).pipe(
  Layer.provide(
    Layer.sync(ConfigProvider.ConfigProvider, () =>
      ConfigProvider.fromEnv({ preserveEmptyStrings: true }),
    ),
  ),
);
