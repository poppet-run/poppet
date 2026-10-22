import {
  ChannelEnvironment,
  ChannelError,
  ChannelInput,
  type ChannelRegistration,
} from "@poppet/gateway";
import { Effect, Redacted, Schema } from "effect";

import { DiscordSettings, discordSettings, saveDiscordSettings } from "#src/settings";

export const discord: ChannelRegistration = {
  id: "discord",
  name: "Discord",
  setupHelp: "setup <bot-id> <owner-id> <guild-id> <channel-id>... --key-stdin",
  setup: (args) =>
    Effect.gen(function* () {
      if (args.length < 6 || args[0] !== "setup" || args.at(-1) !== "--key-stdin")
        return yield* Effect.fail(
          new ChannelError({
            reason: "configuration",
            message:
              "Use gateway discord setup <bot-id> <owner-id> <guild-id> <channel-id>... --key-stdin.",
          }),
        );
      const environment = yield* ChannelEnvironment;
      const input = yield* (yield* ChannelInput).readSecret;

      const settings = yield* Schema.decodeUnknownEffect(DiscordSettings)({
        version: 1,
        botId: args[1],
        ownerId: args[2],
        guildId: args[3],
        channelIds: args.slice(4, -1),
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
  load: discordSettings.loader((settings) =>
    import("#src/channel").then(({ discordChannelLayer }) => discordChannelLayer(settings)),
  ),
};
