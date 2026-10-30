import { parseArgs } from "node:util";

import { ChannelEnvironment, ChannelError, type ChannelRegistration } from "@poppet/gateway";
import { Effect, Layer, Schema } from "effect";

import { DiscordSettings, loadDiscordSettings, saveDiscordSettings } from "#src/settings";
import { promptDiscordSetup } from "#src/setup";

const setupHelp =
  "setup --owner-id <id> --guild-id <id> --home-channel-id <id> --bot-token <token>";

const parseSetup = (args: ReadonlyArray<string>) =>
  Effect.try({
    try: () => {
      if (args[0] !== "setup") throw new Error("Expected setup");

      const { values, tokens } = parseArgs({
        args: args.slice(1),
        options: {
          "owner-id": { type: "string" },
          "guild-id": { type: "string" },
          "home-channel-id": { type: "string" },
          "bot-token": { type: "string" },
        },
        strict: true,
        allowPositionals: false,
        tokens: true,
      });

      const names = tokens.filter((token) => token.kind === "option").map((token) => token.name);

      if (names.length !== 4 || new Set(names).size !== 4)
        throw new Error("Expected each setup flag exactly once");

      return values;
    },
    catch: () =>
      new ChannelError({ reason: "configuration", message: `Use gateway discord ${setupHelp}.` }),
  });

export const discord = {
  id: "discord",
  name: "Discord",
  promptSetup: promptDiscordSetup,
  setupHelp,
  setup: (args) =>
    Effect.gen(function* () {
      const values = yield* parseSetup(args);
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
