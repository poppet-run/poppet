import {
  ChannelEnvironment,
  ChannelError,
  ChannelInput,
  type ChannelRegistration,
} from "@poppet/gateway";
import { Effect, Layer, Redacted, Schema } from "effect";

import { TelegramSettings, loadTelegramSettings, saveTelegramSettings } from "#src/settings";

export const telegram: ChannelRegistration = {
  id: "telegram",
  name: "Telegram",
  setupHelp: "setup <bot-id> <owner-id> --key-stdin",
  setup: (args) =>
    Effect.gen(function* () {
      if (args.length !== 4 || args[0] !== "setup" || args.at(-1) !== "--key-stdin")
        return yield* Effect.fail(
          new ChannelError({
            reason: "configuration",
            message: "Use gateway telegram setup <bot-id> <owner-id> --key-stdin.",
          }),
        );
      const environment = yield* ChannelEnvironment;
      const input = yield* (yield* ChannelInput).readSecret;

      const settings = yield* Schema.decodeUnknownEffect(TelegramSettings)({
        version: 1,
        botId: args[1],
        ownerId: args[2],
        token: Redacted.value(input),
      }).pipe(
        Effect.mapError(
          () =>
            new ChannelError({
              reason: "configuration",
              message:
                "Use positive numeric Telegram bot/owner IDs and a bot token from BotFather.",
            }),
        ),
      );

      yield* saveTelegramSettings(environment.dataDirectory, settings);

      return "Telegram settings saved. Restart the worker to apply them. Only the configured owner can chat with Poppet in a private Telegram chat.";
    }),
  load: Effect.gen(function* () {
    const environment = yield* ChannelEnvironment;

    const settings = yield* loadTelegramSettings(environment.dataDirectory).pipe(
      Effect.mapError(
        () =>
          new ChannelError({
            reason: "configuration",
            message: "Invalid Telegram settings. Run gateway telegram setup again.",
          }),
      ),
    );

    if (settings === null) return null;

    return Layer.unwrap(
      Effect.promise(() => import("#src/channel")).pipe(
        Effect.map(({ telegramChannelLayer }) => telegramChannelLayer(settings)),
      ),
    );
  }),
};
