import { createHash } from "node:crypto";

import { ChannelError, MessagingChannel } from "@poppet/gateway";
import { makeWASocket } from "baileys";
import { Effect, Layer, Stream } from "effect";

import { WhatsAppClient, WhatsAppClientLive, type SocketFactory } from "#src/client";
import type { WhatsAppSettings } from "#src/settings";

export const whatsappChannelLayer = (
  dataDirectory: string,
  settings: WhatsAppSettings,
  createSocket: SocketFactory = makeWASocket,
) =>
  Layer.effect(
    MessagingChannel,
    Effect.gen(function* () {
      const client = yield* WhatsAppClient;

      const check = (id: string) =>
        Effect.try({
          try: () => {
            if (id !== settings.ownerPhone)
              throw new ChannelError({
                reason: "permission",
                message: "Only the configured WhatsApp owner's private chat is authorized.",
              });

            return client.socket();
          },
          catch: (cause) =>
            cause instanceof ChannelError
              ? cause
              : new ChannelError({
                  reason: "configuration",
                  message: "Invalid WhatsApp connection state.",
                }),
        });

      return {
        id: "whatsapp",
        accountId: settings.accountPhone,
        policy: {
          ownerId: settings.ownerPhone,
          scopeId: settings.accountPhone,
          parentIds: [settings.ownerPhone],
        },
        messages: Stream.fromQueue(client.messages),
        conversation: (message) => Effect.succeed(message.conversationId ?? settings.ownerPhone),
        destination: (id) => check(id).pipe(Effect.as(settings.ownerPhone)),
        checkAccess: (message, id) =>
          Effect.gen(function* () {
            if (
              message.senderId !== settings.ownerPhone ||
              message.scopeId !== settings.accountPhone ||
              message.parentId !== settings.ownerPhone
            )
              return yield* Effect.fail(
                new ChannelError({
                  reason: "permission",
                  message: "WhatsApp message is outside the configured owner's private chat.",
                }),
              );
            yield* check(id);
          }),
        typing: (id) =>
          check(id).pipe(
            Effect.flatMap((socket) =>
              Effect.tryPromise({
                try: () => socket.sendPresenceUpdate("composing", `${id}@s.whatsapp.net`),
                catch: () =>
                  new ChannelError({
                    reason: "unavailable",
                    message: "WhatsApp typing update failed.",
                  }),
              }),
            ),
          ),
        mark: () => Effect.void,
        send: (id, text, nonce) =>
          Effect.gen(function* () {
            const socket = yield* check(id);

            if (text.length === 0 || text.length > 4096)
              return yield* Effect.fail(
                new ChannelError({
                  reason: "configuration",
                  message: "WhatsApp reply must contain 1 to 4096 UTF-16 units.",
                }),
              );

            const messageId = `3EB0${createHash("sha256")
              .update(JSON.stringify([settings.accountPhone, nonce]))
              .digest("hex")
              .slice(0, 28)
              .toUpperCase()}`;

            // Save before sending: self-chat echoes must remain recognizable after a lost acknowledgement or restart.
            yield* Effect.try({
              try: () => client.auth.rememberOutgoing(messageId),
              catch: (cause) =>
                cause instanceof ChannelError
                  ? cause
                  : new ChannelError({
                      reason: "configuration",
                      message: "Cannot persist WhatsApp outgoing identity.",
                    }),
            });

            return yield* Effect.tryPromise(async () => {
              const sent = await socket.sendMessage(
                `${id}@s.whatsapp.net`,
                { text, linkPreview: null },
                { messageId },
              );

              if (sent?.key.id !== messageId)
                throw new Error("Missing or mismatched WhatsApp send acknowledgement");

              return messageId;
            }).pipe(
              Effect.timeout("15 seconds"),
              Effect.mapError(
                () =>
                  new ChannelError({
                    reason: "uncertain",
                    message:
                      "WhatsApp may have accepted this reply. Inspect its saved delivery before reposting.",
                  }),
              ),
            );
          }),
        status: client.status,
        textLimit: 4096,
      };
    }),
  ).pipe(Layer.provide(WhatsAppClientLive(dataDirectory, settings, createSocket)));
