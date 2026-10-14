import { Config, ConfigProvider, Context, Effect, Layer, Schema } from "effect";

export interface ChatPolicy {
  readonly contextBytes: number;
  readonly historyTurns: number;
  readonly outputTokens: number;
}

export class ChatSettings extends Context.Service<ChatSettings, ChatPolicy>()(
  "poppet/ChatSettings",
) {}

export const defaultPolicy: ChatPolicy = {
  contextBytes: 65536,
  historyTurns: 20,
  outputTokens: 2048,
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

    return { contextBytes, historyTurns, outputTokens };
  }),
).pipe(
  Layer.provide(
    Layer.sync(ConfigProvider.ConfigProvider, () =>
      ConfigProvider.fromEnv({ preserveEmptyStrings: true }),
    ),
  ),
);
