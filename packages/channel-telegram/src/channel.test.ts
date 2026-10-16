import { describe, expect, test } from "bun:test";

import { MessagingChannel } from "@poppet/gateway";
import { Deferred, Effect, Fiber, Match, Redacted, Schema } from "effect";

import type { HttpFetch } from "#src/api";
import { telegramChannelLayer } from "#src/channel";

const settings = {
  version: 1 as const,
  botId: "100",
  ownerId: "200",
  token: Redacted.make("100:secret-token"),
};

const incoming = (updateId: number, text = "Hello") => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    from: { id: 200, is_bot: false },
    chat: { id: 200, type: "private" },
    text,
  },
});

const fixture = (reply: (method: string) => Schema.Json | null = () => null) => {
  const calls: { method: string; body: Schema.Json }[] = [];

  const http: HttpFetch = async (url, init) => {
    const method = url.split("/").at(-1)!;
    expect(url).toBe(`https://api.telegram.org/bot100:secret-token/${method}`);
    expect(init.redirect).toBe("error");
    calls.push({ method, body: JSON.parse(String(init.body)) });
    const custom = reply(method);

    if (custom !== null) return Response.json(custom);

    const result = Match.value(method).pipe(
      Match.when("getMe", () => ({ id: 100, is_bot: true })),
      Match.when("getChat", () => ({ id: 200, type: "private" })),
      Match.when("sendMessage", () => ({ message_id: 50, chat: { id: 200, type: "private" } })),
      Match.orElse(() => true),
    );

    return Response.json({ ok: true, result });
  };

  return { calls, layer: telegramChannelLayer(settings, http) };
};

describe.concurrent("Telegram adapter", () => {
  test("normalizes only the owner's private text and returns a cursor for every ignored update", async () => {
    const other = incoming(2);
    other.message.from.id = 999;
    const group = incoming(3);
    group.message.chat.type = "group";
    const bot = incoming(4);
    bot.message.from.is_bot = true;

    const state = fixture((method) =>
      method === "getUpdates"
        ? {
            ok: true,
            result: [
              incoming(1),
              other,
              group,
              bot,
              { update_id: 5, edited_message: incoming(1).message },
              { ...incoming(6), message: { ...incoming(6).message, message_thread_id: 1 } },
              incoming(7, " "),
              { update_id: 8, message: { photo: [] } },
            ],
          }
        : null,
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const channel = yield* MessagingChannel;
        const updates = yield* channel.poll!(null);
        expect(updates.map((item) => item.cursor)).toEqual([
          "2",
          "3",
          "4",
          "5",
          "6",
          "7",
          "8",
          "9",
        ]);
        expect(updates.flatMap((item) => (item.message ? [item.message] : []))).toEqual([
          {
            messageId: "1",
            scopeId: "200",
            parentId: "200",
            conversationId: "200",
            senderId: "200",
            text: "Hello",
            mentioned: false,
          },
        ]);
        expect(yield* channel.status).toMatchObject({ connected: true, ignored: 7 });
        yield* channel.poll!("9");
      }).pipe(Effect.provide(state.layer)),
    );
    expect(
      state.calls.filter((call) => call.method === "getUpdates").map((call) => call.body),
    ).toEqual([
      { offset: 0, timeout: 25, limit: 100, allowed_updates: ["message"] },
      { offset: 9, timeout: 25, limit: 100, allowed_updates: ["message"] },
    ]);
  });

  test("validates access and sends bounded plain text without formatting or previews", async () => {
    const state = fixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        const channel = yield* MessagingChannel;

        const message = {
          messageId: "1",
          scopeId: "200",
          parentId: "200",
          conversationId: "200",
          senderId: "200",
          text: "Hello",
          mentioned: false,
        };

        yield* channel.checkAccess(message, "200");
        expect(yield* channel.destination!("200")).toBe("200");
        expect(yield* channel.destination!("999").pipe(Effect.result)).toHaveProperty(
          "failure.reason",
          "permission",
        );
        expect(
          yield* channel.checkAccess({ ...message, senderId: "999" }, "200").pipe(Effect.result),
        ).toHaveProperty("failure.reason", "permission");
        yield* channel.typing("200");
        expect(yield* channel.send("200", "**Plain** <b>text</b>", "nonce")).toBe("50");
        expect(
          yield* channel.send("999", "Wrong chat", "nonce").pipe(Effect.result),
        ).toHaveProperty("failure.reason", "permission");
        expect(
          yield* channel.send("200", "x".repeat(4097), "nonce").pipe(Effect.result),
        ).toHaveProperty("failure.reason", "permission");
      }).pipe(Effect.provide(state.layer)),
    );
    expect(state.calls.filter((call) => call.method === "sendMessage")).toEqual([
      {
        method: "sendMessage",
        body: {
          chat_id: "200",
          text: "**Plain** <b>text</b>",
          link_preview_options: { is_disabled: true },
        },
      },
    ]);
    expect(state.calls.filter((call) => call.method === "getMe")).toHaveLength(1);
    expect(state.calls).toContainEqual({
      method: "sendChatAction",
      body: { chat_id: "200", action: "typing" },
    });
  });

  test.each([
    { code: 429, reason: "unavailable" },
    { code: 403, reason: "permission" },
    { code: 401, reason: "configuration" },
    { code: 500, reason: "uncertain" },
  ])(
    "classifies send error $code without resending or exposing remote diagnostics",
    async ({ code, reason }) => {
      const state = fixture((method) =>
        method === "sendMessage"
          ? {
              ok: false,
              error_code: code,
              description: "100:secret-token",
              parameters: { retry_after: 60 },
            }
          : null,
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const channel = yield* MessagingChannel;
          const result = yield* channel.send("200", "Reply", "nonce").pipe(Effect.result);
          expect(result).toHaveProperty("failure.reason", reason);
          expect(result).toHaveProperty("failure.retryAfterMs", 60000);
          expect(JSON.stringify([result, yield* channel.status])).not.toContain("secret-token");
        }).pipe(Effect.provide(state.layer)),
      );
      expect(state.calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
    },
  );

  test.each(["network", "malformed", "wrong-chat"])(
    "keeps %s send acknowledgements uncertain",
    async (failure) => {
      const http: HttpFetch = async (url) => {
        if (url.endsWith("getMe"))
          return Response.json({ ok: true, result: { id: 100, is_bot: true } });

        if (failure === "network") throw new Error(url);

        if (failure === "malformed") return new Response("secret-token");

        return Response.json({
          ok: true,
          result: { message_id: 50, chat: { id: 999, type: "private" } },
        });
      };

      await Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* (yield* MessagingChannel)
            .send("200", "Reply", "nonce")
            .pipe(Effect.result);

          expect(result).toHaveProperty("failure.reason", "uncertain");
          expect(JSON.stringify(result)).not.toContain("secret-token");
        }).pipe(Effect.provide(telegramChannelLayer(settings, http))),
      );
    },
  );

  test("deduplicates a repeated polling update and rejects an unordered batch without acknowledging it", async () => {
    let ordered = true;

    const state = fixture((method) =>
      method === "getUpdates"
        ? {
            ok: true,
            result: ordered ? [incoming(1), incoming(1), incoming(2)] : [incoming(2), incoming(1)],
          }
        : null,
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const channel = yield* MessagingChannel;
        expect((yield* channel.poll!(null)).map((item) => item.cursor)).toEqual(["2", "3"]);
        ordered = false;
        expect(yield* channel.poll!(null).pipe(Effect.result)).toHaveProperty(
          "failure.reason",
          "unavailable",
        );
      }).pipe(Effect.provide(state.layer)),
    );
  });

  test("bounds response bytes before decoding and redacts malformed provider data", async () => {
    let cancelled = false;

    const http: HttpFetch = async (url) => {
      if (url.endsWith("getMe"))
        return Response.json({ ok: true, result: { id: 100, is_bot: true } });

      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* (yield* MessagingChannel).poll!(null).pipe(Effect.result);
        expect(result).toHaveProperty("failure.reason", "unavailable");
        expect(cancelled).toBe(true);
        expect(JSON.stringify(result)).not.toContain("secret-token");
      }).pipe(Effect.provide(telegramChannelLayer(settings, http))),
    );
  });

  test("a mismatched bot cannot poll or send", async () => {
    const state = fixture((method) =>
      method === "getMe" ? { ok: true, result: { id: 999, is_bot: true } } : null,
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const channel = yield* MessagingChannel;
        expect(yield* channel.poll!(null).pipe(Effect.result)).toHaveProperty(
          "failure.reason",
          "configuration",
        );
        expect(yield* channel.send("200", "Reply", "nonce").pipe(Effect.result)).toHaveProperty(
          "failure.reason",
          "configuration",
        );
      }).pipe(Effect.provide(state.layer)),
    );
    expect(state.calls.map((call) => call.method)).toEqual(["getMe", "getMe"]);
  });

  test.each(["getUpdates", "sendMessage"])(
    "cancellation aborts an active %s request",
    async (method) => {
      const started = Deferred.makeUnsafe<void>();
      let aborted = false;

      const http: HttpFetch = async (url, init) => {
        if (url.endsWith("getMe"))
          return Response.json({ ok: true, result: { id: 100, is_bot: true } });

        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error(url));
            },
            { once: true },
          );
          Effect.runSync(Deferred.succeed(started, undefined));
        });
      };

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const channel = yield* MessagingChannel;

            const fiber = yield* (
              method === "getUpdates" ? channel.poll!(null) : channel.send("200", "Reply", "nonce")
            ).pipe(Effect.forkScoped);

            yield* Deferred.await(started);
            yield* Fiber.interrupt(fiber);
            expect(aborted).toBe(true);
          }),
        ).pipe(Effect.provide(telegramChannelLayer(settings, http))),
      );
    },
  );
});
