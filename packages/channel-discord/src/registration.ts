import {
  ChannelEnvironment,
  ChannelError,
  parseSetupFlags,
  type ChannelRegistration,
} from "@poppet/gateway";
import { Effect, Layer, Schema } from "effect";

import { DiscordSettings, loadDiscordSettings, saveDiscordSettings } from "#src/settings";
import { promptDiscordSetup } from "#src/setup";

const setupHelp =
  "setup --owner-id <id> --guild-id <id> --home-channel-id <id> --bot-token <token>";

export const discord = {
  id: "discord",
  name: "Discord",
  promptSetup: promptDiscordSetup,
  setupHelp,
  setup: (args) =>
    Effect.gen(function* () {
      const values = yield* parseSetupFlags(args, "discord", setupHelp, [
        "owner-id",
        "guild-id",
        "home-channel-id",
        "bot-token",
      ]);

      const environment = yield* ChannelEnvironment;

      const settings = yield* Schema.decodeUnknownEffect(DiscordSettings)({
        ownerId: values["owner-id"],
        guildId: values["guild-id"],
        homeChannelId: values["home-channel-id"],
        token: values["bot-token"],
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
} satisfies ChannelRegistration;
