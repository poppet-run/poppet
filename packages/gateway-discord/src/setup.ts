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
    "Use Discord Developer Mode to copy IDs. Only the configured owner can invoke Poppet; channel members can read its replies.",
  );

  const ownerId = yield* id("Your Discord user ID", defaults?.ownerId);
  const guildId = yield* id("Server ID", defaults?.guildId);

  const homeChannelId = yield* id(
    "Home channel ID (default destination for scheduled results and notifications)",
    defaults?.homeChannelId,
  );

  const replaceToken =
    saved === null ||
    (yield* Prompt.Confirm({ message: "Replace the saved bot token?", initial: false }));

  const token = replaceToken
    ? yield* promptSecret(
        "Discord bot token",
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
