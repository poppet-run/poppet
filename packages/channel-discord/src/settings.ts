import { ChannelError, loadChannelSettings, saveChannelSettings } from "@poppet/gateway";
import { Effect, Schema } from "effect";

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

const SavedSettings = Schema.fromJsonString(DiscordSettings);

const settingsError = () =>
  new ChannelError({
    reason: "configuration",
    message: "Cannot read or write protected Discord settings. Run gateway discord setup again.",
  });

export const loadDiscordSettings = (dataDirectory: string) =>
  Effect.gen(function* () {
    const contents = yield* loadChannelSettings(dataDirectory, "discord");

    if (contents === null) return null;

    return yield* Schema.decodeUnknownEffect(SavedSettings, { onExcessProperty: "error" })(
      contents,
    );
  }).pipe(Effect.mapError(settingsError));

export const saveDiscordSettings = (dataDirectory: string, settings: DiscordSettings) =>
  Schema.encodeEffect(SavedSettings)(settings).pipe(
    Effect.flatMap((contents) => saveChannelSettings(dataDirectory, "discord", contents)),
    Effect.mapError(settingsError),
  );
