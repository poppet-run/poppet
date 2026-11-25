import { channelSettings } from "@poppet/gateway";
import { Schema } from "effect";

const UserId = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,15}$/));

const ChatId = Schema.String.check(Schema.isPattern(/^-?[1-9][0-9]{0,15}$/));

/** The configured chat itself, or `<chat-id>:<topic-id>` for a forum topic. */
export const ConversationId = Schema.String.check(
  Schema.isPattern(/^-?[1-9][0-9]{0,15}(?::[1-9][0-9]{0,9})?$/),
);

const Token = Schema.RedactedFromValue(
  Schema.String.check(Schema.isPattern(/^[0-9]{1,20}:[A-Za-z0-9_-]{1,256}$/)),
);

const sameChat = (settings: { chatId: string; homeConversationId: string }) =>
  settings.homeConversationId === settings.chatId ||
  settings.homeConversationId.startsWith(`${settings.chatId}:`);

/** Policy and token live together: config.json has no section for external channels. */
export const TelegramSettings = Schema.Struct({
  ownerId: UserId,
  chatId: ChatId,
  homeConversationId: ConversationId,
  token: Token,
}).check(
  Schema.makeFilter(
    (settings) =>
      // A private chat's ID is the user's ID, so only the owner's own chat qualifies.
      (settings.chatId.startsWith("-") || settings.chatId === settings.ownerId) &&
      sameChat(settings),
  ),
);

export type TelegramSettings = typeof TelegramSettings.Type;

export const telegramSettings = channelSettings("telegram", "Telegram", TelegramSettings);
