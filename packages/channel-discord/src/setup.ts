import { DiscordConfiguration, readConfigFile } from "@poppet/config";
import { ChannelEnvironment, ChannelError } from "@poppet/gateway";
import { Console, Effect, Schema } from "effect";
import { Prompt } from "effect/cli";

import { loadDiscordSettings, saveDiscordSettings } from "#src/settings";

const id = (message: string, value: string | undefined) =>
  Prompt.String({
    message,
    default: value ?? "",
    validate: (input) =>
      Schema.is(DiscordConfiguration.fields.ownerId)(input)
        ? Effect.succeed(input)
        : Effect.fail("Enter a numeric Discord ID, up to 20 digits."),
  });

export const promptDiscordSetup = Effect.gen(function* () {
  if (!(yield* Prompt.Confirm({ message: "Configure Discord?", initial: false }))) return null;

  const { dataDirectory } = yield* ChannelEnvironment;
  const saved = yield* loadDiscordSettings(dataDirectory);

  const { file } = yield* readConfigFile(dataDirectory).pipe(
    Effect.mapError(
      () =>
        new ChannelError({
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
    ? yield* Prompt.Password({
        message: "Discord bot token",
        validate: (input) =>
          /^\S{1,8192}$/.test(input)
            ? Effect.succeed(input)
            : Effect.fail("Enter a nonempty bot token without whitespace, up to 8192 characters."),
      })
    : saved.token;

  return saveDiscordSettings(dataDirectory, {
    ownerId,
    guildId,
    homeChannelId,
    token,
  }).pipe(
    Effect.as(`Saved Discord owner ${ownerId}, server ${guildId}, home channel ${homeChannelId}.`),
  );
});
