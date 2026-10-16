import { ChannelError, loadChannelSettings, saveChannelSettings } from "@poppet/gateway";
import { Effect, Schema } from "effect";

/** Telegram's positive numeric user IDs, represented as text at the channel boundary. */
export const TelegramId = Schema.String.check(
  Schema.isPattern(/^[1-9]\d{0,15}$/),
  Schema.makeFilter((value) => Number.isSafeInteger(Number(value))),
);

/** One bot and one owner, restricted to their private chat. */
export const TelegramSettings = Schema.Struct({
  version: Schema.Literal(1),
  botId: TelegramId,
  ownerId: TelegramId,
  token: Schema.RedactedFromValue(
    Schema.String.check(Schema.isPattern(/^\d+:[A-Za-z0-9_-]{1,256}$/)),
  ),
});

export type TelegramSettings = typeof TelegramSettings.Type;

const SavedSettings = Schema.fromJsonString(TelegramSettings);

const settingsError = () =>
  new ChannelError({
    reason: "configuration",
    message: "Cannot read or write protected Telegram settings. Run gateway telegram setup again.",
  });

export const loadTelegramSettings = (dataDirectory: string) =>
  Effect.gen(function* () {
    const contents = yield* loadChannelSettings(dataDirectory, "telegram");

    if (contents === null) return null;

    return yield* Schema.decodeUnknownEffect(SavedSettings, { onExcessProperty: "error" })(
      contents,
    );
  }).pipe(Effect.mapError(settingsError));

export const saveTelegramSettings = (dataDirectory: string, settings: TelegramSettings) =>
  Schema.encodeEffect(SavedSettings)(settings).pipe(
    Effect.flatMap((contents) => saveChannelSettings(dataDirectory, "telegram", contents)),
    Effect.mapError(settingsError),
  );
