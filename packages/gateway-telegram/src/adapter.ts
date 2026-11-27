import { GatewayAdapter, GatewayError } from "@poppet/gateway";
import type { ApprovalAction, ApprovalPrompt, IncomingMessage } from "@poppet/gateway";
import { timeoutSeconds } from "@poppet/io";
import { Deferred, Duration, Effect, Layer, Option, Queue, Schedule, Schema, Stream } from "effect";

import {
  CallbackQuery,
  Chat,
  ChatMember,
  Done,
  Edited,
  ForumTopic,
  Me,
  Message,
  Sent,
  TelegramApiError,
  Updates,
  telegramApi,
} from "#src/api";
import type { Fetch } from "#src/api";
import {
  approvalCallback,
  approvalDetailsHtml,
  approvalHtml,
  approvalMarkup,
  settledMarkup,
  telegramSettlementHtml,
} from "#src/approvals";
import { ConversationId } from "#src/settings";
import type { TelegramSettings } from "#src/settings";

const mentions = (message: Message, username: string, botId: number) =>
  (message.entities ?? []).some((entity) => {
    if (entity.type === "text_mention") {
      return entity.user?.id === botId;
    }

    const text = message.text?.slice(entity.offset, entity.offset + entity.length) ?? "";

    return (
      (entity.type === "mention" && text.toLowerCase() === `@${username.toLowerCase()}`) ||
      (entity.type === "bot_command" && text.toLowerCase().endsWith(`@${username.toLowerCase()}`))
    );
  });

const withTopic = (params: { [key: string]: Schema.Json }, threadId: number | null) => {
  if (threadId !== null) {
    params["message_thread_id"] = threadId;
  }

  return params;
};

const failureMessage = (cause: unknown) => {
  if (!(cause instanceof TelegramApiError)) {
    return "Telegram operation failed. Check the network connection to api.telegram.org.";
  }

  if (cause.code === 401) {
    return "Telegram rejected the bot token. Run gateway telegram setup again.";
  }

  if (cause.code === 409) {
    return "Another client or a webhook is receiving updates for this bot. Stop it or delete the webhook.";
  }

  if (cause.code === 429) {
    return "Telegram rate limit reached; retrying later.";
  }

  return "Telegram operation failed. Check the bot's chat membership and topic permissions.";
};

const telegramFailure = (cause: unknown, sending = false) =>
  cause instanceof GatewayError
    ? cause
    : new GatewayError({
        reason:
          cause instanceof TelegramApiError
            ? cause.code === 429 || cause.code === 409
              ? "unavailable"
              : cause.code < 500
                ? "permission"
                : sending
                  ? "uncertain"
                  : "unavailable"
            : sending
              ? "uncertain"
              : "unavailable",
        message: failureMessage(cause),
        retryAfterMs: cause instanceof TelegramApiError ? cause.retryAfterMs : 0,
      });

// Telegram limits topic names to 128 characters; never cut an astral character to meet it.
const topicName = (title: string) => {
  let name = "";

  for (const character of title.trim()) {
    if (name.length + character.length > 128) {
      break;
    }

    name += character;
  }

  return name || "New conversation";
};

const reactions = { working: "👀", completed: "👍" } as const;

export const telegramAdapterLayer = (
  settings: TelegramSettings,
  fetcher: Fetch = (input, init) => fetch(input, init),
) =>
  Layer.effect(
    GatewayAdapter,
    Effect.gen(function* () {
      const requestSeconds = yield* timeoutSeconds("gatewayRequestSeconds");
      const retrySeconds = yield* timeoutSeconds("gatewayRetrySeconds");
      const pollSeconds = yield* timeoutSeconds("telegramPollSeconds");
      const call = telegramApi(settings.token, fetcher, requestSeconds * 1000);
      const chatId = Number(settings.chatId);
      const messages = yield* Queue.make<IncomingMessage>({ capacity: 64, strategy: "dropping" });
      const actions = yield* Queue.make<ApprovalAction>({ capacity: 64, strategy: "dropping" });
      const callbacks = yield* Queue.make<CallbackQuery>({ capacity: 64, strategy: "dropping" });
      const nameChanges = yield* Queue.make<string>({ capacity: 64, strategy: "dropping" });
      const prompts = new Map<string, ApprovalPrompt>();
      // The Bot API cannot read a topic's name, so names come from service messages and our edits.
      const topicNames = new Map<string, string>();
      const identity = yield* Deferred.make<string>();
      let bot: { readonly id: number; readonly username: string } | null = null;
      let connected = false;
      let connectionError: string | null = null;
      let dropped = 0;
      let offset = 0;

      const topic = (threadId: number) => `${settings.chatId}:${threadId}`;

      const requireReady = () => {
        if (bot === null) {
          throw new GatewayError({ reason: "unavailable", message: "Telegram is disconnected." });
        }

        return bot;
      };

      // The topic ID within the configured chat, null for the chat itself, or a permission failure.
      const target = (conversationId: string) => {
        if (Schema.is(ConversationId)(conversationId)) {
          if (conversationId === settings.chatId) {
            return null;
          }

          if (conversationId.startsWith(`${settings.chatId}:`)) {
            return Number(conversationId.slice(settings.chatId.length + 1));
          }
        }

        throw new GatewayError({
          reason: "permission",
          message: "Choose the configured Telegram chat or one of its forum topics.",
        });
      };

      const incoming = (message: Message) => {
        if (bot === null || message.chat.id !== chatId) {
          return;
        }

        const threadId = message.message_thread_id;
        const named = message.forum_topic_created?.name ?? message.forum_topic_edited?.name;

        if (threadId !== undefined && named !== undefined) {
          const id = topic(threadId);
          const previous = topicNames.get(id);
          topicNames.set(id, named);

          if (message.forum_topic_edited !== undefined && previous !== named) {
            Queue.offerUnsafe(nameChanges, id);
          }

          return;
        }

        const sender = message.from;

        if (
          sender === undefined ||
          sender.is_bot ||
          String(sender.id) !== settings.ownerId ||
          message.sender_chat !== undefined ||
          message.via_bot !== undefined ||
          message.text === undefined
        ) {
          return;
        }

        const reply = message.reply_to_message;

        const mentioned =
          message.chat.type === "private" ||
          mentions(message, bot.username, bot.id) ||
          // Forum messages reply to their topic's creation message unless they quote another.
          (reply?.from?.id === bot.id && reply.forum_topic_created === undefined);

        const text = message.text.replaceAll(new RegExp(`@${bot.username}\\b`, "gi"), "").trim();

        if (!text || text.length > 8192) {
          return;
        }

        const conversationId =
          message.chat.is_forum !== true
            ? settings.chatId
            : message.is_topic_message === true && threadId !== undefined
              ? topic(threadId)
              : null;

        if (
          !Queue.offerUnsafe(messages, {
            messageId: String(message.message_id),
            scopeId: settings.chatId,
            parentId: settings.chatId,
            conversationId,
            senderId: settings.ownerId,
            text,
            mentioned,
          })
        ) {
          dropped++;
        }
      };

      const reportError = (error: GatewayError) =>
        Effect.sync(() => {
          connectionError = error.message;
        });

      const login = Effect.tryPromise({
        try: (signal) => call("getMe", {}, Me, signal),
        catch: telegramFailure,
      }).pipe(
        Effect.tapError(reportError),
        Effect.retry(Schedule.spaced(Duration.seconds(retrySeconds))),
        Effect.tap((me) =>
          Effect.sync(() => {
            bot = { id: me.id, username: me.username };
            Deferred.doneUnsafe(identity, Effect.succeed(String(me.id)));
          }),
        ),
      );

      // Each request confirms every update before its offset, so redelivery follows only a restart.
      const poll = Effect.tryPromise({
        try: (signal) =>
          call(
            "getUpdates",
            { offset, timeout: pollSeconds, allowed_updates: ["message", "callback_query"] },
            Updates,
            signal,
            (pollSeconds + requestSeconds) * 1000,
          ),
        catch: telegramFailure,
      }).pipe(
        Effect.tap((updates) =>
          Effect.sync(() => {
            connected = true;
            connectionError = null;

            for (const update of updates) {
              offset = Math.max(offset, update.update_id + 1);
              const message = Schema.decodeUnknownOption(Message)(update.message);

              if (Option.isSome(message)) {
                incoming(message.value);
              }

              const query = Schema.decodeUnknownOption(CallbackQuery)(update.callback_query);

              if (Option.isSome(query) && !Queue.offerUnsafe(callbacks, query.value)) {
                dropped++;
              }
            }
          }),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            connected = false;
            yield* reportError(error);
            yield* Effect.sleep(Math.max(error.retryAfterMs ?? 0, 5000));
          }),
        ),
      );

      yield* login.pipe(
        Effect.andThen(Effect.suspend(() => poll).pipe(Effect.forever)),
        Effect.forkScoped,
      );

      const request = <S extends Schema.ConstraintDecoder<unknown>>(
        method: string,
        params: Schema.JsonObject,
        schema: S,
        sending = false,
      ) =>
        Effect.tryPromise({
          try: (signal) => call(method, params, schema, signal),
          catch: (cause) => telegramFailure(cause, sending),
        });

      const answerCallback = (queryId: string, text: string, showAlert = false) =>
        request(
          "answerCallbackQuery",
          {
            callback_query_id: queryId,
            text: text.slice(0, 200),
            ...(showAlert && { show_alert: true }),
          },
          Done,
        ).pipe(Effect.asVoid);

      const handleCallback = (query: CallbackQuery) =>
        Effect.gen(function* () {
          if (bot === null) {
            return;
          }

          const click = approvalCallback(query, settings, bot.id);

          if (click.kind === "ignored") {
            return;
          }

          if (click.kind === "rejected") {
            yield* answerCallback(
              click.queryId,
              "Only the configured owner can answer this approval.",
              true,
            );

            return;
          }

          if (click.kind === "details") {
            const saved = prompts.get(click.requestId);

            if (!saved) {
              yield* answerCallback(
                click.queryId,
                "Full details are no longer available for this approval.",
                true,
              );

              return;
            }

            yield* answerCallback(click.queryId, "Showing full payload.");

            for (const part of approvalDetailsHtml(saved.canonicalPayload)) {
              yield* request(
                "sendMessage",
                withTopic(
                  {
                    chat_id: chatId,
                    text: part,
                    parse_mode: "HTML",
                    link_preview_options: { is_disabled: true },
                  },
                  click.threadId,
                ),
                Sent,
                true,
              );
            }

            return;
          }

          const reply = (text: string) => answerCallback(click.queryId, text);

          if (
            !Queue.offerUnsafe(actions, {
              requestId: click.requestId,
              decision: click.decision,
              source: click.source,
              reply,
            })
          ) {
            yield* reply("Poppet is busy. Try this approval again before it expires.");
          }
        }).pipe(Effect.catch(() => Effect.void));

      yield* Stream.fromQueue(callbacks).pipe(Stream.runForEach(handleCallback), Effect.forkScoped);

      const authorize = (message: IncomingMessage) => {
        if (
          message.scopeId !== settings.chatId ||
          message.parentId !== settings.chatId ||
          message.senderId !== settings.ownerId
        ) {
          throw new GatewayError({
            reason: "permission",
            message: "This Telegram message is outside the configured chat or owner.",
          });
        }
      };

      // Topics require a forum; group chats also require the bot to be able to post.
      const checkChat = (inTopic: boolean) =>
        Effect.gen(function* () {
          const botId = requireReady().id;

          if (settings.chatId === settings.ownerId && !inTopic) {
            return;
          }

          const chat = yield* request("getChat", { chat_id: chatId }, Chat);

          const member = yield* request(
            "getChatMember",
            { chat_id: chatId, user_id: botId },
            ChatMember,
          );

          if (
            (inTopic && chat.is_forum !== true) ||
            member.status === "left" ||
            member.status === "kicked" ||
            member.can_send_messages === false
          ) {
            return yield* Effect.fail(
              new GatewayError({
                reason: "permission",
                message: "The bot cannot post in this Telegram chat or topic.",
              }),
            );
          }
        });

      const checkAccess = (message: IncomingMessage, conversationId: string) =>
        Effect.try({
          try: () => {
            authorize(message);

            return target(conversationId);
          },
          catch: telegramFailure,
        }).pipe(
          Effect.flatMap((threadId) => checkChat(threadId !== null)),
          Effect.tapError(reportError),
        );

      const conversation = (message: IncomingMessage, title: string) =>
        Effect.gen(function* () {
          if (message.conversationId !== null) {
            return { id: message.conversationId, managedName: null };
          }

          yield* Effect.try({ try: () => authorize(message), catch: telegramFailure });
          yield* checkChat(true);

          // Without an idempotency key, a lost acknowledgement may leave an extra topic behind.
          const created = yield* request(
            "createForumTopic",
            { chat_id: chatId, name: topicName(title) },
            ForumTopic,
            true,
          );

          const id = topic(created.message_thread_id);
          topicNames.set(id, created.name);

          return { id, managedName: created.name };
        }).pipe(Effect.tapError(reportError));

      const knownName = (id: string) => {
        const name = topicNames.get(id);

        if (name === undefined) {
          throw new GatewayError({
            reason: "unavailable",
            message: "Telegram has not reported this topic's name since the worker started.",
          });
        }

        return name;
      };

      return {
        id: "telegram",
        accountId: Deferred.await(identity),
        policy: {
          ownerId: settings.ownerId,
          scopeId: settings.chatId,
        },
        homeConversationId: settings.homeConversationId,
        messages: Stream.fromQueue(messages),
        textLimit: 4096,
        status: Effect.sync(() => ({
          adapter: "telegram",
          account: bot === null ? null : String(bot.id),
          connected,
          error: connectionError,
          dropped,
        })),
        checkAccess,
        destination: (conversationId) =>
          Effect.try({ try: () => target(conversationId), catch: telegramFailure }).pipe(
            Effect.flatMap((threadId) => checkChat(threadId !== null)),
            Effect.as(settings.chatId),
          ),
        mark: (message, state) =>
          Effect.try({ try: () => authorize(message), catch: telegramFailure }).pipe(
            Effect.andThen(
              request(
                "setMessageReaction",
                {
                  chat_id: chatId,
                  message_id: Number(message.messageId),
                  reaction: state === "stopped" ? [] : [{ type: "emoji", emoji: reactions[state] }],
                },
                Done,
              ),
            ),
            Effect.asVoid,
          ),
        typing: (conversationId) =>
          Effect.try({ try: () => target(conversationId), catch: telegramFailure }).pipe(
            Effect.flatMap((threadId) =>
              request(
                "sendChatAction",
                withTopic({ chat_id: chatId, action: "typing" }, threadId),
                Done,
              ),
            ),
            Effect.asVoid,
          ),
        naming: {
          sanitize: topicName,
          conversation,
          changes: Stream.fromQueue(nameChanges),
          current: (message, id) =>
            checkAccess(message, id).pipe(
              Effect.andThen(Effect.try({ try: () => knownName(id), catch: telegramFailure })),
            ),
          rename: (message, id, expected, title) =>
            checkAccess(message, id).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  const threadId = yield* Effect.try({
                    try: () => target(id),
                    catch: telegramFailure,
                  });

                  const current = yield* Effect.try({
                    try: () => knownName(id),
                    catch: telegramFailure,
                  });

                  if (threadId === null || current !== expected) {
                    return null;
                  }

                  const name = topicName(title);

                  yield* request(
                    "editForumTopic",
                    { chat_id: chatId, message_thread_id: threadId, name },
                    Done,
                    true,
                  );

                  topicNames.set(id, name);

                  return name;
                }),
              ),
            ),
        },
        // Telegram has no idempotency key, so the nonce cannot prevent a duplicate after a lost reply.
        send: (conversationId, text) =>
          Effect.try({ try: () => target(conversationId), catch: telegramFailure }).pipe(
            Effect.flatMap((threadId) =>
              request(
                "sendMessage",
                withTopic(
                  { chat_id: chatId, text, link_preview_options: { is_disabled: true } },
                  threadId,
                ),
                Sent,
                true,
              ),
            ),
            Effect.map((sent) => String(sent.message_id)),
          ),
        approvals: {
          actions: Stream.fromQueue(actions),
          send: (conversationId, prompt) =>
            Effect.try({ try: () => target(conversationId), catch: telegramFailure }).pipe(
              Effect.flatMap((threadId) =>
                request(
                  "sendMessage",
                  withTopic(
                    {
                      chat_id: chatId,
                      text: approvalHtml(prompt),
                      parse_mode: "HTML",
                      reply_markup: approvalMarkup(
                        prompt.requestId,
                        prompt.truncated,
                        prompt.alwaysAllow !== undefined,
                      ),
                      link_preview_options: { is_disabled: true },
                    },
                    threadId,
                  ),
                  Sent,
                  true,
                ),
              ),
              Effect.tap(() =>
                Effect.sync(() => {
                  prompts.set(prompt.requestId, prompt);
                }),
              ),
              Effect.map((sent) => String(sent.message_id)),
            ),
          update: (_conversationId, messageId, requestId, state, settlement) =>
            Effect.gen(function* () {
              const saved = prompts.get(requestId);
              prompts.delete(requestId);

              const text = saved
                ? approvalHtml(saved, { state, ...(settlement && { settlement }) })
                : telegramSettlementHtml(state, settlement);

              yield* request(
                "editMessageText",
                {
                  chat_id: chatId,
                  message_id: Number(messageId),
                  text,
                  parse_mode: "HTML",
                  reply_markup: settledMarkup,
                  link_preview_options: { is_disabled: true },
                },
                Edited,
                true,
              );
            }),
        },
      } satisfies GatewayAdapter["Service"];
    }),
  );
