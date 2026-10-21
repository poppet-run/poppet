import {
  ChannelError,
  MessagingChannel,
  safeAttachmentName,
  type Attachment,
  type IncomingMessage,
  type PolledMessage,
} from "@poppet/gateway";
import { Effect, Layer, Option, Schema, Stream } from "effect";

import { telegramApi, telegramDownload, type HttpFetch } from "#src/api";
import type { TelegramSettings } from "#src/settings";

const Integer = Schema.Int.check(Schema.makeFilter(Number.isSafeInteger));

const PositiveId = Integer.check(Schema.isGreaterThan(0));

const Chat = Schema.Struct({ id: PositiveId, type: Schema.Literal("private") });

const User = Schema.Struct({ id: PositiveId, is_bot: Schema.Boolean });

const Message = Schema.Struct({
  message_id: PositiveId,
  from: User,
  chat: Chat,
  text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
  caption: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
  document: Schema.optionalKey(Schema.Json),
  voice: Schema.optionalKey(Schema.Json),
  photo: Schema.optionalKey(Schema.Json),
  audio: Schema.optionalKey(Schema.Json),
  video: Schema.optionalKey(Schema.Json),
  animation: Schema.optionalKey(Schema.Json),
  video_note: Schema.optionalKey(Schema.Json),
  sticker: Schema.optionalKey(Schema.Json),
  media_group_id: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  forward_origin: Schema.optionalKey(Schema.Json),
  message_thread_id: Schema.optionalKey(PositiveId),
});

const File = Schema.Struct({
  file_id: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
  file_name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  mime_type: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  file_size: Schema.optionalKey(Schema.Natural),
  duration: Schema.optionalKey(Schema.Natural),
});

interface FileMetadata {
  size?: number;
  duration?: number;
}

const attachmentFrom = (input: typeof Message.Type): Attachment | undefined => {
  const media = [
    input.document,
    input.voice,
    input.photo,
    input.audio,
    input.video,
    input.animation,
    input.video_note,
    input.sticker,
  ].filter((value) => value !== undefined);

  if (media.length === 0) return undefined;

  const unsupported: Attachment = {
    kind: "unsupported",
    fileId: "unsupported",
    name: "Unsupported attachment",
    mime: "",
  };

  if (
    media.length !== 1 ||
    input.media_group_id !== undefined ||
    input.forward_origin !== undefined ||
    (input.document === undefined && input.voice === undefined)
  )
    return unsupported;
  const file = Option.getOrNull(Schema.decodeUnknownOption(File)(input.document ?? input.voice));

  if (file === null) return unsupported;

  const optional: FileMetadata = {};

  if (file.file_size !== undefined) optional.size = file.file_size;

  if (file.duration !== undefined) optional.duration = file.duration;

  return {
    kind: input.voice === undefined ? "document" : "voice",
    fileId: file.file_id,
    name: safeAttachmentName(
      input.voice === undefined ? (file.file_name ?? "Document") : "Voice message",
    ),
    mime: (file.mime_type ?? "").toLowerCase(),
    ...optional,
  };
};

const Updates = Schema.Array(
  Schema.Struct({
    update_id: Integer.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThan(Number.MAX_SAFE_INTEGER),
    ),
    message: Schema.optionalKey(Schema.Json),
  }),
).check(Schema.isMaxLength(100));

export const telegramChannelLayer = (settings: TelegramSettings, http: HttpFetch = fetch) =>
  Layer.sync(MessagingChannel, () => {
    const request = telegramApi(settings, http);
    let verified = false;
    let connected = false;
    let error: string | null = null;
    let ignored = 0;
    const owner = settings.ownerId;

    const observe = <A>(operation: Effect.Effect<A, ChannelError>) =>
      operation.pipe(
        Effect.tap(
          Effect.sync(() => {
            connected = true;
            error = null;
          }),
        ),
        Effect.tapError((failure) =>
          Effect.sync(() => {
            connected = false;
            error = failure.message;
          }),
        ),
      );

    const identity = Effect.gen(function* () {
      if (verified) return;
      const bot = yield* request("getMe", {}, User);

      if (!bot.is_bot || String(bot.id) !== settings.botId)
        return yield* Effect.fail(
          new ChannelError({
            reason: "configuration",
            message: "The Telegram token does not match the configured bot ID.",
          }),
        );
      verified = true;
    });

    const privateChat = (id: string) =>
      Effect.gen(function* () {
        if (id !== owner)
          return yield* Effect.fail(
            new ChannelError({
              reason: "permission",
              message: "Only the configured owner's private Telegram chat is authorized.",
            }),
          );
        yield* identity;
        const chat = yield* request("getChat", { chat_id: owner }, Chat);

        if (String(chat.id) !== owner)
          return yield* Effect.fail(
            new ChannelError({
              reason: "permission",
              message: "Telegram returned a different private chat.",
            }),
          );
      });

    return {
      id: "telegram",
      accountId: settings.botId,
      policy: { ownerId: owner, scopeId: owner, parentIds: [owner] },
      messages: Stream.never,
      poll: (cursor) =>
        observe(
          Effect.gen(function* () {
            yield* identity;
            const offset = cursor === null ? 0 : Number(cursor);

            if (!Number.isSafeInteger(offset) || offset < 0)
              return yield* Effect.fail(
                new ChannelError({
                  reason: "configuration",
                  message: "Invalid saved Telegram polling offset.",
                }),
              );

            const updates = yield* request(
              "getUpdates",
              { offset, timeout: 25, limit: 10, allowed_updates: ["message"] },
              Updates,
              false,
              35000,
            );

            const polled: PolledMessage[] = [];
            let previous = offset - 1;

            for (const update of updates) {
              if (update.update_id < offset || update.update_id === previous) continue;

              if (update.update_id <= previous)
                return yield* Effect.fail(
                  new ChannelError({
                    reason: "unavailable",
                    message: "Telegram returned unordered updates.",
                  }),
                );
              previous = update.update_id;
              const input = Option.getOrNull(Schema.decodeUnknownOption(Message)(update.message));
              let message: IncomingMessage | null = null;

              if (
                input !== null &&
                !input.from.is_bot &&
                String(input.from.id) === owner &&
                String(input.chat.id) === owner &&
                input.message_thread_id === undefined
              ) {
                const attachment = attachmentFrom(input);

                const text =
                  input.forward_origin !== undefined && attachment !== undefined
                    ? ""
                    : (input.text ?? input.caption ?? "").trim();

                if (text || attachment !== undefined) {
                  const normalized: IncomingMessage = {
                    messageId: String(update.update_id),
                    scopeId: owner,
                    parentId: owner,
                    conversationId: owner,
                    senderId: owner,
                    text,
                    mentioned: false,
                  };

                  message = attachment === undefined ? normalized : { ...normalized, attachment };
                }
              }

              if (message === null) ignored++;
              polled.push({ cursor: String(update.update_id + 1), message });
            }

            return polled;
          }),
        ),
      conversation: (message) => Effect.succeed(message.conversationId ?? owner),
      checkAccess: (message, id) =>
        observe(
          Effect.gen(function* () {
            if (
              message.senderId !== owner ||
              message.scopeId !== owner ||
              message.parentId !== owner
            )
              return yield* Effect.fail(
                new ChannelError({
                  reason: "permission",
                  message: "Telegram message is outside the configured owner's private chat.",
                }),
              );
            yield* privateChat(id);
          }),
        ),
      destination: (id) => observe(privateChat(id).pipe(Effect.as(owner))),
      download: (message, maxBytes) =>
        Effect.gen(function* () {
          if (
            message.senderId !== owner ||
            message.scopeId !== owner ||
            message.parentId !== owner ||
            message.conversationId !== owner ||
            message.attachment === undefined ||
            message.attachment.kind === "unsupported"
          )
            return yield* Effect.fail(
              new ChannelError({
                reason: "permission",
                message: "Only the original owner's private Telegram attachment can be downloaded.",
              }),
            );
          yield* privateChat(owner);

          return yield* telegramDownload(settings, http, message.attachment, maxBytes);
        }),
      typing: (id) =>
        observe(
          Effect.gen(function* () {
            if (id !== owner) return;
            yield* identity;
            yield* request("sendChatAction", { chat_id: id, action: "typing" }, Schema.Boolean);
          }),
        ),
      mark: () => Effect.void,
      send: (id, text) =>
        observe(
          Effect.gen(function* () {
            if (id !== owner || text.length === 0 || text.length > 4096)
              return yield* Effect.fail(
                new ChannelError({
                  reason: "permission",
                  message: "Invalid Telegram reply destination or text length.",
                }),
              );
            yield* identity;

            // Telegram has no sendMessage idempotency key; the gateway retains uncertain sends without replay.
            const sent = yield* request(
              "sendMessage",
              { chat_id: id, text, link_preview_options: { is_disabled: true } },
              Schema.Struct({ message_id: PositiveId, chat: Chat }),
              true,
            );

            if (String(sent.chat.id) !== owner)
              return yield* Effect.fail(
                new ChannelError({
                  reason: "uncertain",
                  message: "Telegram returned an unexpected reply destination.",
                }),
              );

            return String(sent.message_id);
          }),
        ),
      textLimit: 4096,
      status: Effect.sync(() => ({
        adapter: "telegram",
        account: settings.botId,
        connected,
        error,
        ignored,
      })),
    };
  });
