import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingChannel } from "@poppet/gateway";
import {
  DisconnectReason,
  makeEventBuffer,
  type UserFacingSocketConfig,
  type WAMessage,
} from "baileys";
import { Deferred, Effect, Fiber, Option, Stream } from "effect";
import { TestClock } from "effect/testing";

import { openWhatsAppAuth } from "#src/auth";
import { whatsappChannelLayer } from "#src/channel";
import { quietLogger, type SocketFactory, type WhatsAppSocket } from "#src/client";
import type { WhatsAppSettings } from "#src/settings";

const settings: WhatsAppSettings = {
  version: 1,
  accountPhone: "447700900001",
  ownerPhone: "447700900002",
};

const message = (id: string, phone = settings.ownerPhone, fromMe = false): WAMessage => ({
  key: { id, remoteJid: `${phone}@s.whatsapp.net`, fromMe },
  message: { conversation: "Hello" },
});

const fixture = async (configuration = settings, paired = true) => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-wa-channel-"));

  if (paired)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* openWhatsAppAuth(directory, () => undefined);
          auth.saveCreds({
            me: { id: `${configuration.accountPhone}:1@s.whatsapp.net` },
          });
        }),
      ),
    );
  const sockets: WhatsAppSocket[] = [];
  const configs: UserFacingSocketConfig[] = [];
  const sent: { jid: string; id: string; text: string }[] = [];
  const lids = new Map<string, string>();
  let ended = 0;
  let loseSend = false;
  let echo = false;
  let created = Deferred.makeUnsafe<WhatsAppSocket>();

  const factory: SocketFactory = (config) => {
    configs.push(config);
    const ev = makeEventBuffer(quietLogger);

    const socket: WhatsAppSocket = {
      ev,
      user: { id: `${configuration.accountPhone}:1@s.whatsapp.net` },
      signalRepository: { lidMapping: { getPNForLID: async (lid) => lids.get(lid) ?? null } },
      sendMessage: async (jid, content, options) => {
        const id = options?.messageId ?? "missing-id";

        if (!("text" in content)) throw new Error("Unexpected non-text send");
        sent.push({ jid, id, text: content.text });
        expect(content.linkPreview).toBeNull();

        const reply = {
          key: { id, remoteJid: jid, fromMe: true },
          message: { conversation: content.text },
        };

        if (echo) ev.emit("messages.upsert", { messages: [reply], type: "notify" });

        if (loseSend) throw new Error("secret-remote-error");

        return reply;
      },
      sendPresenceUpdate: async () => undefined,
      end: async () => {
        ended++;
        ev.destroy();
      },
    };

    sockets.push(socket);
    Effect.runSync(Deferred.succeed(created, socket));

    return socket;
  };

  const layer = whatsappChannelLayer(directory, configuration, factory);

  const open = Effect.gen(function* () {
    const socket = yield* Deferred.await(created);
    yield* Effect.yieldNow;
    socket.ev.emit("connection.update", { connection: "open" });
    yield* Effect.yieldNow;
    const channel = yield* MessagingChannel;
    expect(yield* channel.status).toHaveProperty("connected", true);

    return socket;
  });

  return {
    directory,
    configs,
    sockets,
    sent,
    lids,
    open,
    loseSend: () => {
      loseSend = true;
    },
    echo: () => {
      echo = true;
    },
    nextSocket: () => {
      created = Deferred.makeUnsafe<WhatsAppSocket>();

      return Deferred.await(created);
    },
    ended: () => ended,
    run: <A, E>(program: Effect.Effect<A, E, MessagingChannel>) => {
      created = Deferred.makeUnsafe<WhatsAppSocket>();

      return Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
      );
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

describe.concurrent("WhatsApp adapter", () => {
  test("accepts only owner text, resolves private LIDs and ignores other accounts, groups and edits", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const socket = yield* state.open;
          const channel = yield* MessagingChannel;
          state.lids.set("12345@lid", `${settings.ownerPhone}@s.whatsapp.net`);
          socket.ev.emit("messages.upsert", {
            type: "notify",
            messages: [
              message("other", "447700900099"),
              message("outgoing", settings.ownerPhone, true),
              { ...message("group"), key: { id: "group", remoteJid: "123@g.us" } },
              {
                ...message("edit"),
                message: { protocolMessage: { type: 14, editedMessage: { conversation: "edit" } } },
              },
              { ...message("image"), message: { imageMessage: { caption: "not text" } } },
              { ...message("owner"), key: { id: "owner", remoteJid: "12345@lid" } },
              message("second-owner"),
            ],
          });
          const received = yield* Stream.runCollect(channel.messages.pipe(Stream.take(2)));
          expect(received.map((item) => item.messageId)).toEqual(["owner", "second-owner"]);
          expect(received[0]).toMatchObject({
            messageId: "owner",
            senderId: settings.ownerPhone,
            conversationId: settings.ownerPhone,
            scopeId: settings.accountPhone,
          });
          expect(yield* channel.destination!(settings.ownerPhone)).toBe(settings.ownerPhone);
          expect(yield* channel.destination!("447700900099").pipe(Effect.result)).toHaveProperty(
            "failure.reason",
            "permission",
          );
          expect(
            yield* channel.send(settings.ownerPhone, "x".repeat(4097), "id").pipe(Effect.result),
          ).toHaveProperty("failure.reason", "configuration");
          expect(state.configs[0]).toMatchObject({
            syncFullHistory: false,
            emitOwnEvents: false,
            maxMsgRetryCount: 0,
            enableRecentMessageCache: false,
          });
        }),
      );
      expect(state.sent).toEqual([]);
      expect(state.ended()).toBe(1);
    } finally {
      await state.close();
    }
  });

  test("bounds receive buffering and sends stable plain-text identities without fetching previews", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const socket = yield* state.open;
          const channel = yield* MessagingChannel;

          const first = yield* channel.send(
            settings.ownerPhone,
            "https://example.invalid/",
            "stable",
          );

          const second = yield* channel.send(
            settings.ownerPhone,
            "https://example.invalid/",
            "stable",
          );

          expect(first).toBe(second);
          expect(state.sent.map((sent) => sent.jid)).toEqual([
            `${settings.ownerPhone}@s.whatsapp.net`,
            `${settings.ownerPhone}@s.whatsapp.net`,
          ]);
          socket.ev.emit("messages.upsert", {
            type: "notify",
            messages: Array.from({ length: 65 }, (_, index) => message(`input-${index}`)),
          });
          yield* Effect.yieldNow;
          expect(yield* channel.status).toHaveProperty("dropped", 1);
          expect((yield* Stream.runCollect(channel.messages.pipe(Stream.take(64)))).length).toBe(
            64,
          );
        }),
      );
    } finally {
      await state.close();
    }
  });

  test.each(["identity", "storage", "replaced"])(
    "stops safely after %s failure",
    async (reason) => {
      const state = await fixture();

      try {
        await state.run(
          Effect.gen(function* () {
            const socket = yield* state.open;
            const channel = yield* MessagingChannel;

            if (reason === "identity") {
              socket.user!.id = "447700900099:1@s.whatsapp.net";
              socket.ev.emit("connection.update", { connection: "open" });
            } else if (reason === "storage") {
              using database = new Database(join(state.directory, "channels/whatsapp-auth.sqlite"));
              database.run(
                "CREATE TRIGGER reject_creds BEFORE UPDATE ON auth BEGIN SELECT RAISE(ABORT, 'secret-storage-error'); END",
              );
              socket.ev.emit("creds.update", {});
            } else {
              socket.ev.emit("connection.update", {
                connection: "close",
                lastDisconnect: {
                  date: new Date(),
                  error: Object.assign(new Error("secret-connection-error"), {
                    output: { statusCode: DisconnectReason.connectionReplaced },
                  }),
                },
              });
            }

            yield* Effect.yieldNow;
            yield* TestClock.adjust("30 seconds");
            expect(state.sockets).toHaveLength(1);
            expect(state.ended()).toBe(1);
            expect(yield* channel.status).toHaveProperty("connected", false);
            expect(JSON.stringify(yield* channel.status)).not.toContain("secret-");
            expect(
              yield* channel.send(settings.ownerPhone, "Reply", "id").pipe(Effect.result),
            ).toHaveProperty("failure.reason", "unavailable");
          }),
        );
        expect(state.sent).toEqual([]);
      } finally {
        await state.close();
      }
    },
  );

  test("self-chat echoes cannot start a reply loop, including after a lost acknowledgement and restart", async () => {
    const config = { ...settings, ownerPhone: settings.accountPhone };
    const state = await fixture(config);
    state.echo();
    state.loseSend();

    try {
      await state.run(
        Effect.gen(function* () {
          const socket = yield* state.open;
          const channel = yield* MessagingChannel;

          const result = yield* channel
            .send(config.ownerPhone, "Answer", "gateway-1")
            .pipe(Effect.result);

          expect(result).toHaveProperty("failure.reason", "uncertain");
          expect(JSON.stringify([result, yield* channel.status])).not.toContain(
            "secret-remote-error",
          );
          socket.ev.emit("messages.upsert", {
            messages: [message("human", config.ownerPhone, true)],
            type: "notify",
          });
          expect(Option.getOrNull(yield* Stream.runHead(channel.messages))?.messageId).toBe(
            "human",
          );
        }),
      );
      await state.run(
        Effect.gen(function* () {
          const socket = yield* state.open;
          const channel = yield* MessagingChannel;
          socket.ev.emit("messages.upsert", {
            messages: [
              message(state.sent[0]!.id, config.ownerPhone, true),
              message("after-restart", config.ownerPhone, true),
            ],
            type: "append",
          });
          expect(Option.getOrNull(yield* Stream.runHead(channel.messages))?.messageId).toBe(
            "after-restart",
          );
        }),
      );
      expect(state.sent).toHaveLength(1);
      expect(state.ended()).toBe(2);
    } finally {
      await state.close();
    }
  });

  test("an unacknowledged send times out as uncertain without retrying", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const socket = yield* state.open;
          const started = Deferred.makeUnsafe<void>();
          let attempts = 0;
          socket.sendMessage = () => {
            attempts++;
            Effect.runSync(Deferred.succeed(started, undefined));

            return new Promise<never>(() => undefined);
          };

          const channel = yield* MessagingChannel;

          const sending = yield* channel
            .send(settings.ownerPhone, "Answer", "timed-out")
            .pipe(Effect.result, Effect.forkChild);

          yield* Deferred.await(started);
          yield* TestClock.adjust("15 seconds");
          expect(yield* Fiber.join(sending)).toHaveProperty("failure.reason", "uncertain");
          expect(attempts).toBe(1);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("does not connect or expose a QR when the worker has not been paired", async () => {
    const state = await fixture(settings, false);

    try {
      await state.run(
        Effect.gen(function* () {
          const channel = yield* MessagingChannel;
          expect(yield* channel.status).toMatchObject({ connected: false, needsPairing: true });
          expect(
            yield* channel.send(settings.ownerPhone, "Reply", "id").pipe(Effect.result),
          ).toHaveProperty("failure.reason", "unavailable");
        }),
      );
      expect(state.sockets).toEqual([]);
    } finally {
      await state.close();
    }
  });

  test.each(["transient", "unstructured"])(
    "reconnects a %s disconnect, closes the previous socket and stops after unlinking",
    async (reason) => {
      const state = await fixture();

      try {
        await state.run(
          Effect.gen(function* () {
            const first = yield* state.open;
            const next = state.nextSocket();
            first.ev.emit("connection.update", {
              connection: "close",
              lastDisconnect: {
                error: Object.assign(
                  new Error("private"),
                  reason === "transient"
                    ? { output: { statusCode: DisconnectReason.connectionLost } }
                    : {},
                ),
                date: new Date(),
              },
            });
            yield* TestClock.adjust("1 second");
            const second = yield* next;
            expect(state.ended()).toBe(1);
            second.ev.emit("connection.update", { connection: "open" });
            yield* Effect.yieldNow;
            second.ev.emit("connection.update", {
              connection: "close",
              lastDisconnect: {
                error: Object.assign(new Error("private"), {
                  output: { statusCode: DisconnectReason.loggedOut },
                }),
                date: new Date(),
              },
            });
            yield* Effect.yieldNow;
            yield* TestClock.adjust("30 seconds");
            expect(state.sockets).toHaveLength(2);
            expect(yield* (yield* MessagingChannel).status).toMatchObject({
              connected: false,
              needsPairing: true,
            });
          }),
        );
        expect(state.ended()).toBe(2);
      } finally {
        await state.close();
      }
    },
  );
});
