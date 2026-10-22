import { channelSettings } from "@poppet/gateway";
import { Schema } from "effect";

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

const store = channelSettings("telegram", "Telegram", TelegramSettings);

export const loadTelegramSettings = store.load;

export const saveTelegramSettings = store.save;
