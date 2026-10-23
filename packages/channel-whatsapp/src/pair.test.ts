import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DisconnectReason, makeEventBuffer } from "baileys";
import { Deferred, Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";

import { quietLogger, WhatsAppClient, WhatsAppClientLive, type SocketFactory } from "#src/client";
import { pairWhatsApp } from "#src/pair";

const settings = { version: 1 as const, accountPhone: "447700900001", ownerPhone: "447700900002" };

describe.concurrent("pairWhatsApp", () => {
  test("when pairing never links before its deadline, closes the socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-wa-pair-deadline-"));
    const created = Deferred.makeUnsafe<void>();
    let closed = 0;

    const factory: SocketFactory = () => {
      const ev = makeEventBuffer(quietLogger);
      Effect.runSync(Deferred.succeed(created, undefined));

      return {
        ev,
        user: undefined,
        signalRepository: { lidMapping: { getPNForLID: async () => null } },
        sendMessage: async () => {
          throw new Error("Pairing must not send messages");
        },
        sendPresenceUpdate: async () => undefined,
        end: async () => {
          closed++;
          ev.destroy();
        },
      };
    };

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* pairWhatsApp(directory, settings, factory).pipe(
            Effect.result,
            Effect.forkChild,
          );

          yield* Deferred.await(created);
          yield* TestClock.adjust("2 minutes");
          expect(yield* Fiber.join(fiber)).toMatchObject({
            failure: {
              reason: "configuration",
              message: "WhatsApp pairing timed out or failed. Run gateway whatsapp pair again.",
            },
          });
          expect(closed).toBe(1);
        }).pipe(Effect.provide(TestClock.layer())),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["paired", "invalid-session", "wrong-account", "cancelled"])(
    "when pairing ends as %s, releases the socket and persists only a verified session",
    async (outcome) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-wa-pair-"));
      const first = Deferred.makeUnsafe<void>();
      const second = Deferred.makeUnsafe<void>();
      const events: ReturnType<typeof makeEventBuffer>[] = [];
      const qr: string[] = [];
      let closed = 0;

      const factory: SocketFactory = (config) => {
        if (events.length === 1 && outcome === "invalid-session")
          expect(config.auth.creds.me).toBeUndefined();
        const ev = makeEventBuffer(quietLogger);
        events.push(ev);
        Effect.runSync(Deferred.succeed(events.length === 1 ? first : second, undefined));

        return {
          ev,
          user: {
            id: `${outcome === "wrong-account" ? "447700900099" : settings.accountPhone}:1@s.whatsapp.net`,
          },
          signalRepository: { lidMapping: { getPNForLID: async () => null } },
          sendMessage: async () => {
            throw new Error("Pairing must not send messages");
          },
          sendPresenceUpdate: async () => undefined,
          end: async () => {
            closed++;
            ev.destroy();
          },
        };
      };

      const layer = WhatsAppClientLive(directory, settings, factory, (value) =>
        Effect.sync(() => {
          qr.push(value);
        }),
      );

      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const client = yield* WhatsAppClient;
            yield* Deferred.await(first);
            yield* Effect.yieldNow;
            events[0]!.emit("connection.update", { qr: "private-qr" });
            yield* Effect.yieldNow;
            expect(qr).toEqual(["private-qr"]);
            expect(JSON.stringify(yield* client.status)).not.toContain("private-qr");

            if (outcome === "cancelled") return;
            events[0]!.emit("creds.update", {
              me: { id: `${settings.accountPhone}:1@s.whatsapp.net` },
            });
            events[0]!.emit("connection.update", {
              connection: "close",
              lastDisconnect: {
                error: Object.assign(new Error("Restart required"), {
                  output: {
                    statusCode:
                      outcome === "invalid-session"
                        ? DisconnectReason.badSession
                        : DisconnectReason.restartRequired,
                  },
                }),
                date: new Date(),
              },
            });
            yield* TestClock.adjust("1 second");
            yield* Deferred.await(second);
            yield* Effect.yieldNow;

            if (outcome === "invalid-session")
              events[1]!.emit("creds.update", {
                me: { id: `${settings.accountPhone}:1@s.whatsapp.net` },
              });
            events[1]!.emit("connection.update", { connection: "open" });
            const result = yield* client.linked.pipe(Effect.result);
            expect(Result.isSuccess(result)).toBe(
              outcome === "paired" || outcome === "invalid-session",
            );
          }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
        );
        expect(closed).toBe(outcome === "cancelled" ? 1 : 2);
        const paired = outcome === "paired" || outcome === "invalid-session";
        const socketsBeforeRestart = events.length;
        await Effect.runPromise(
          Effect.gen(function* () {
            const client = yield* WhatsAppClient;
            yield* Effect.yieldNow;
            expect(yield* client.status).toMatchObject({
              connected: false,
              needsPairing: !paired,
              error: paired ? null : expect.any(String),
            });
            expect(events).toHaveLength(socketsBeforeRestart + (paired ? 1 : 0));
          }).pipe(Effect.provide(WhatsAppClientLive(directory, settings, factory))),
        );
        expect(closed).toBe(events.length);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
