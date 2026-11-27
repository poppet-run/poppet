import { GatewayError, GatewayFetch } from "@poppet/gateway";
import type { Redacted } from "effect";
import { Effect, Schema } from "effect";

import { Me, TelegramApiError, telegramApi } from "#src/api";

const messages = new Map([
  [401, "Telegram rejected the bot token."],
  [404, "Telegram rejected the bot token."],
  [
    409,
    "Another client is reading this bot's updates, such as a running worker or a webhook, so setup cannot see recent messages.",
  ],
]);

const failure = (error: TelegramApiError | null) =>
  new GatewayError({
    reason:
      error !== null && (error.code === 401 || error.code === 404) ? "permission" : "unavailable",
    message:
      error === null
        ? "Telegram could not be reached."
        : (messages.get(error.code) ?? `Telegram answered: ${error.message}`),
  });

const Sender = Schema.Struct({
  id: Schema.Number,
  is_bot: Schema.Boolean,
  username: Schema.optionalKey(Schema.String),
  first_name: Schema.optionalKey(Schema.String),
});

const SeenChat = Schema.Struct({
  id: Schema.Number,
  type: Schema.String,
  title: Schema.optionalKey(Schema.String),
  username: Schema.optionalKey(Schema.String),
  first_name: Schema.optionalKey(Schema.String),
});

const Seen = Schema.Struct({
  message: Schema.optionalKey(Schema.Struct({ chat: SeenChat, from: Schema.optionalKey(Sender) })),
  my_chat_member: Schema.optionalKey(Schema.Struct({ chat: SeenChat, from: Sender })),
});

const isSeen = Schema.is(Seen);

const label = (named: { username?: string; first_name?: string; title?: string }) =>
  named.title ?? (named.username === undefined ? named.first_name : `@${named.username}`) ?? "";

export interface Found {
  readonly id: string;
  readonly name: string;
}

/** Read-only Bot API calls that setup uses to check a token and offer IDs. */
export const telegramProbe = (token: Redacted.Redacted<string>) => {
  const call = <S extends Schema.ConstraintDecoder<unknown>>(
    method: string,
    params: Schema.JsonObject,
    schema: S,
  ) =>
    Effect.gen(function* () {
      const fetch = yield* GatewayFetch;

      return yield* Effect.tryPromise({
        try: (signal) => telegramApi(token, fetch, 10_000)(method, params, schema, signal),
        catch: (error) => failure(error instanceof TelegramApiError ? error : null),
      });
    });

  return {
    bot: call("getMe", {}, Me),
    /**
     * Lists people and chats from updates still queued for the bot. Without an
     * offset this confirms nothing, so the worker still receives them later.
     */
    recent: call("getUpdates", { timeout: 0, limit: 100 }, Schema.Array(Schema.Unknown)).pipe(
      Effect.map((updates) => {
        const people = new Map<string, Found>();
        const chats = new Map<string, Found & { readonly private: boolean }>();

        for (const update of updates.filter(isSeen)) {
          const seen = update.message ?? update.my_chat_member;

          if (seen === undefined) {
            continue;
          }

          const { chat, from } = seen;

          if (from !== undefined && !from.is_bot && chat.type === "private") {
            people.set(String(from.id), { id: String(from.id), name: label(from) });
          }

          if (chat.type === "private" || chat.type === "group" || chat.type === "supergroup") {
            chats.set(String(chat.id), {
              id: String(chat.id),
              name: chat.type === "private" ? `Private chat with ${label(chat)}` : label(chat),
              private: chat.type === "private",
            });
          }
        }

        return { people: [...people.values()], chats: [...chats.values()] };
      }),
    ),
  };
};
