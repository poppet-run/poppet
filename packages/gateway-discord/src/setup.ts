import { DiscordConfiguration, readConfigFile } from "@poppet/config";
import { promptSecret } from "@poppet/credentials/input";
import { GatewayEnvironment, GatewayError } from "@poppet/gateway";
import type { GatewayPromptSetup } from "@poppet/gateway";
import { Console, Effect, Schema } from "effect";
import { Prompt } from "effect/cli";

import { loadDiscordSettings, removeDiscordSettings, saveDiscordSettings } from "#src/settings";

const id = (message: string, value: string | undefined) =>
  Prompt.String({
    message,
    default: value ?? "",
    validate: (input) =>
      Schema.is(DiscordConfiguration.fields.ownerId)(input)
        ? Effect.succeed(input)
        : Effect.fail("Enter a numeric Discord ID, up to 20 digits."),
  });

const prompt = Effect.gen(function* () {
  const { dataDirectory } = yield* GatewayEnvironment;
  const saved = yield* loadDiscordSettings(dataDirectory);

  const { file } = yield* readConfigFile(dataDirectory).pipe(
    Effect.mapError(
      () =>
        new GatewayError({
          reason: "configuration",
          message: "Cannot read Discord configuration from config.json.",
        }),
    ),
  );

  const defaults = file.discord ?? saved;

  yield* Console.log(
    [
      "Create a bot at https://discord.com/developers/applications, turn on its Message Content intent, and invite it to your server.",
      "To copy IDs, turn on Developer Mode in Discord under Settings > Advanced, then right-click a user, server, or channel.",
      "Guide: https://poppet.run/docs/gateways/discord/",
      "Only the configured owner can invoke Poppet; channel members can read its replies.",
    ].join("\n"),
  );

  const ownerId = yield* id(
    "Your Discord user ID (right-click your name > Copy User ID)",
    defaults?.ownerId,
  );

  const guildId = yield* id(
    "Server ID (right-click the server icon > Copy Server ID)",
    defaults?.guildId,
  );

  const homeChannelId = yield* id(
    "Home channel ID for scheduled results and notifications (right-click the channel > Copy Channel ID)",
    defaults?.homeChannelId,
  );

  const replaceToken =
    saved === null ||
    (yield* Prompt.Confirm({ message: "Replace the saved bot token?", initial: false }));

  const token = replaceToken
    ? yield* promptSecret(
        "Discord bot token (Developer Portal > your app > Bot > Reset Token)",
        "Enter a nonempty bot token without whitespace, up to 8192 characters.",
      )
    : saved.token;

  return {
    summary: `owner ${ownerId}, server ${guildId}, home channel ${homeChannelId}, bot token ${replaceToken ? "replaced" : "kept"}`,
    save: saveDiscordSettings(dataDirectory, { ownerId, guildId, homeChannelId, token }).pipe(
      Effect.as(
        `Saved Discord owner ${ownerId}, server ${guildId}, home channel ${homeChannelId}.`,
      ),
    ),
  };
});

export const promptDiscordSetup = {
  configured: GatewayEnvironment.use(({ dataDirectory }) =>
    loadDiscordSettings(dataDirectory).pipe(Effect.map((saved) => saved !== null)),
  ),
  prompt,
  remove: GatewayEnvironment.use(({ dataDirectory }) =>
    removeDiscordSettings(dataDirectory).pipe(
      Effect.as("Removed Discord settings and tokens. Restart the worker to disconnect Discord."),
    ),
  ),
} satisfies GatewayPromptSetup;
