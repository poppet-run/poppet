import {
  ChannelEnvironment,
  ChannelError,
  ChannelInput,
  type ChannelRegistration,
} from "@poppet/gateway";
import { Effect, Layer, Redacted, Schema } from "effect";

import { DiscordSettings, loadDiscordSettings, saveDiscordSettings } from "#src/settings";

export const discord: ChannelRegistration = {
  id: "discord",
  name: "Discord",
  setupHelp: "setup <owner-id> <guild-id> <home-channel-id> --key-stdin",
  setup: (args) =>
    Effect.gen(function* () {
      if (args.length !== 5 || args[0] !== "setup" || args.at(-1) !== "--key-stdin")
        return yield* Effect.fail(
          new ChannelError({
            reason: "configuration",
            message:
              "Use gateway discord setup <owner-id> <guild-id> <home-channel-id> --key-stdin.",
          }),
        );
      const environment = yield* ChannelEnvironment;
      const input = yield* (yield* ChannelInput).readSecret;

      const settings = yield* Schema.decodeUnknownEffect(DiscordSettings)({
        ownerId: args[1],
        guildId: args[2],
        homeChannelId: args[3],
        token: Redacted.value(input),
      }).pipe(
        Effect.mapError(
          () =>
            new ChannelError({
              reason: "configuration",
              message: "Use numeric Discord IDs and a nonempty bot token without whitespace.",
            }),
        ),
      );

      yield* saveDiscordSettings(environment.dataDirectory, settings);

      return "Discord settings saved. Restart the worker to apply them. Only the configured owner can invoke Poppet; channel members can read its replies.";
    }),
  load: Effect.gen(function* () {
    const { dataDirectory } = yield* ChannelEnvironment;
    const settings = yield* loadDiscordSettings(dataDirectory);

    if (settings === null) return null;

    return Layer.unwrap(
      Effect.promise(() =>
        import("#src/channel").then(({ discordChannelLayer }) => discordChannelLayer(settings)),
      ),
    );
  }),
};
