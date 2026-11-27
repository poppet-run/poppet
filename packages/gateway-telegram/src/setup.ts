import { GatewayEnvironment, pickSetupId, recoverSetupCheck } from "@poppet/gateway";
import type { GatewayError, GatewayPromptSetup } from "@poppet/gateway";
import type { Redacted } from "effect";
import { Console, Effect, Result, Schema } from "effect";
import { Prompt } from "effect/cli";

import type { Found } from "#src/probe";
import { telegramProbe } from "#src/probe";
import { ChatId, ConversationId, Token, UserId, sameChat, telegramSettings } from "#src/settings";

const id = (
  message: string,
  value: string | undefined,
  valid: (input: string) => boolean,
  hint: string,
) =>
  Prompt.String({
    message,
    default: value ?? "",
    validate: (input) => (valid(input) ? Effect.succeed(input) : Effect.fail(hint)),
  });

const isToken = Schema.is(Schema.toEncoded(Token));

const promptToken = Prompt.Password({
  message: "Telegram bot token, like 123456:ABC... (from @BotFather)",
  validate: (input) =>
    isToken(input) ? Effect.succeed(input) : Effect.fail("Enter the token BotFather gave you."),
});

const noneFound = {
  people: new Array<Found>(),
  chats: new Array<Found & { readonly private: boolean }>(),
};

const prompt = Effect.gen(function* () {
  const { dataDirectory } = yield* GatewayEnvironment;
  const saved = yield* telegramSettings.load(dataDirectory);

  yield* Console.log(
    [
      "Create a bot by messaging @BotFather on Telegram and sending /newbot. To use a group, add the bot to it.",
      "Guide: https://poppet.run/docs/gateways/telegram/",
      "Only the configured owner can invoke Poppet; chat members can read its replies.",
    ].join("\n"),
  );

  let replaceToken =
    saved === null ||
    (yield* Prompt.Confirm({ message: "Replace the saved bot token?", initial: false }));

  let token: Redacted.Redacted<string> =
    replaceToken || saved === null ? yield* promptToken : saved.token;

  let bot: Result.Result<{ readonly id: number; readonly username: string }, GatewayError> =
    yield* telegramProbe(token).bot.pipe(Effect.result);

  while (Result.isFailure(bot)) {
    yield* Console.log(bot.failure.message);

    const next = yield* recoverSetupCheck("Telegram");

    if (next === "skip") {
      return null;
    }

    if (next === "continue") {
      yield* Console.log(
        "Setup will save the token unchecked; run poppet doctor once the worker is running.",
      );

      break;
    }

    replaceToken = true;
    token = yield* promptToken;
    bot = yield* telegramProbe(token).bot.pipe(Effect.result);
  }

  const account = Result.isSuccess(bot) ? bot.success : null;
  let found = noneFound;

  if (account !== null) {
    yield* Console.log(`Telegram accepted the token for @${account.username}.`);

    yield* Console.log(
      `To list your account and chats here, send @${account.username} a message, or mention it in the group. The worker answers queued messages when it starts.`,
    );

    for (;;) {
      const recent = yield* telegramProbe(token).recent.pipe(Effect.result);

      if (Result.isFailure(recent)) {
        yield* Console.log(recent.failure.message);

        break;
      }

      found = recent.success;

      if (found.people.length > 0 || found.chats.length > 0) {
        break;
      }

      const next = yield* Prompt.Select({
        message: `No messages to @${account.username} yet.`,
        choices: [
          { title: "Look again after sending one", value: "again" as const },
          { title: "Enter the IDs instead", value: "type" as const },
        ],
      });

      if (next === "type") {
        break;
      }
    }
  }

  const ownerId = yield* pickSetupId(
    "Your Telegram account",
    found.people,
    saved?.ownerId,
    id(
      "Your Telegram user ID (message @userinfobot to see it)",
      saved?.ownerId,
      Schema.is(UserId),
      "Enter a numeric Telegram user ID.",
    ),
  );

  const chatId = yield* pickSetupId(
    "Chat Poppet serves",
    found.chats.filter((chat) => !chat.private || chat.id === ownerId),
    saved?.chatId,
    id(
      "Chat ID: your user ID for a private chat with the bot, or a group's negative ID",
      saved?.chatId ?? ownerId,
      (input) => Schema.is(ChatId)(input) && (input.startsWith("-") || input === ownerId),
      "Enter your own user ID, or a group ID starting with -.",
    ),
  );

  const savedHome =
    saved !== null && sameChat({ chatId, homeConversationId: saved.homeConversationId })
      ? saved.homeConversationId
      : chatId;

  const homeConversationId = chatId.startsWith("-")
    ? yield* id(
        "Home conversation for scheduled results: Enter for the whole chat, or <chat-id>:<topic-id> for a forum topic",
        savedHome,
        (input) =>
          Schema.is(ConversationId)(input) && sameChat({ chatId, homeConversationId: input }),
        `Enter ${chatId} or ${chatId}:<topic-id>.`,
      )
    : chatId;

  return {
    summary: [
      `owner ${ownerId}, chat ${chatId}, home conversation ${homeConversationId}`,
      `bot token ${replaceToken ? "replaced" : "kept"}`,
      account !== null ? `checked as @${account.username}` : "not checked",
    ].join(", "),
    save: telegramSettings
      .save(dataDirectory, { ownerId, chatId, homeConversationId, token })
      .pipe(
        Effect.as(
          `Saved Telegram owner ${ownerId}, chat ${chatId}, home conversation ${homeConversationId}.`,
        ),
      ),
  };
});

export const promptTelegramSetup = {
  configured: GatewayEnvironment.use(({ dataDirectory }) =>
    telegramSettings.load(dataDirectory).pipe(Effect.map((saved) => saved !== null)),
  ),
  prompt,
  remove: GatewayEnvironment.use(({ dataDirectory }) =>
    telegramSettings
      .remove(dataDirectory)
      .pipe(
        Effect.as(
          "Removed Telegram settings and token. Restart the worker to disconnect Telegram.",
        ),
      ),
  ),
} satisfies GatewayPromptSetup;
