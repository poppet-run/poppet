import { channelSettings } from "@poppet/gateway";
import { Schema } from "effect";

/** A Discord snowflake kept as text to preserve integer precision. */
export const DiscordId = Schema.String.check(Schema.isPattern(/^\d{1,20}$/));

/** Protected bot credentials and the explicit owner, guild, and channels allowed to use them. */
export const DiscordSettings = Schema.Struct({
  version: Schema.Literal(1),
  botId: DiscordId,
  ownerId: DiscordId,
  guildId: DiscordId,
  channelIds: Schema.Array(DiscordId).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  token: Schema.RedactedFromValue(Schema.String.check(Schema.isPattern(/^\S{1,8192}$/))),
});

export type DiscordSettings = typeof DiscordSettings.Type;

export const discordSettings = channelSettings("discord", "Discord", DiscordSettings);

export const loadDiscordSettings = discordSettings.load;

export const saveDiscordSettings = discordSettings.save;
