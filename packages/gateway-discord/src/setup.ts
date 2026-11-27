import { DiscordConfiguration, readConfigFile } from "@poppet/config";
import { promptSecret } from "@poppet/credentials/input";
import { GatewayEnvironment, GatewayError, pickSetupId } from "@poppet/gateway";
import type { GatewayPromptSetup } from "@poppet/gateway";
import { Console, Effect, Result, Schema } from "effect";
import { Prompt } from "effect/cli";

import { discordProbe } from "#src/probe";
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

  const replaceToken =
    saved === null ||
    (yield* Prompt.Confirm({ message: "Replace the saved bot token?", initial: false }));

  const token = replaceToken
    ? yield* promptSecret(
        "Discord bot token (Developer Portal > your app > Bot > Reset Token)",
        "Enter a nonempty bot token without whitespace, up to 8192 characters.",
      )
    : saved.token;

  const probe = discordProbe(token);
  const bot = yield* probe.bot.pipe(Effect.result);
  const checked = Result.isSuccess(bot);

  const found = <A>(lookup: Effect.Effect<A, GatewayError>, empty: A) =>
    checked ? lookup.pipe(Effect.orElseSucceed(() => empty)) : Effect.succeed(empty);

  yield* Console.log(
    checked
      ? `Discord accepted the token for bot ${bot.success.username} (${bot.success.id}).`
      : `${bot.failure.message} Setup can still save it; run poppet doctor once the worker is running.`,
  );

  const ownerId = yield* id(
    "Your Discord user ID (right-click your name > Copy User ID)",
    defaults?.ownerId ?? (yield* found(probe.owner, null)) ?? undefined,
  );

  const guilds = yield* found(probe.guilds, []);

  if (checked && guilds.length === 0) {
    yield* Console.log(
      `The bot is not in a server yet. Invite it from https://discord.com/oauth2/authorize?client_id=${bot.success.id}&scope=bot with the permissions in the guide.`,
    );
  }

  const guildId = yield* pickSetupId(
    "Server",
    guilds,
    defaults?.guildId,
    id("Server ID (right-click the server icon > Copy Server ID)", defaults?.guildId),
  );

  const channels = yield* found(probe.textChannels(guildId), []);

  const homeChannelId = yield* pickSetupId(
    "Home channel for scheduled results and notifications",
    channels.map((channel) => ({ id: channel.id, name: `#${channel.name}` })),
    defaults?.homeChannelId,
    id(
      "Home channel ID for scheduled results and notifications (right-click the channel > Copy Channel ID)",
      defaults?.homeChannelId,
    ),
  );

  return {
    summary: [
      `owner ${ownerId}, server ${guildId}, home channel ${homeChannelId}`,
      `bot token ${replaceToken ? "replaced" : "kept"}`,
      checked ? `checked as ${bot.success.username}` : "not checked",
    ].join(", "),
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
