import { describe, expect, test } from "bun:test";

import { MessagingChannel } from "@poppet/gateway";
import type { IncomingMessage } from "@poppet/gateway";
import { Effect, Option, Redacted, Schema, Stream } from "effect";

import { telegramChannelLayer } from "#src/channel";

const token = "123456:telegram-secret";

const settings = {
  ownerId: "200",
  chatId: "-100500",
  homeConversationId: "-100500",
  token: Redacted.make(token),
};

const owner = { id: 200, is_bot: false, username: "owner" };
const forum = { id: -100_500, type: "supergroup", is_forum: true };

type Reply = { result: Schema.Json } | { error: number; retryAfter?: number } | "network";

const rejection = (reply: { error: number; retryAfter?: number }) =>
  Response.json(
    {
      ok: false,
      error_code: reply.error,
      description: "Rejected",
      parameters: { retry_after: reply.retryAfter ?? 0 },
    },
    { status: reply.error },
  );

/** A Bot API stand-in that records calls and serves one batch of updates. */
const fakeApi = (
  updates: ReadonlyArray<Schema.Json>,
  replies: ReadonlyMap<string, Reply> = new Map(),
) => {
  const calls: Array<{ method: string; body: Schema.Json }> = [];
  let pending = [...updates];

  const fetcher = async (input: string, init: RequestInit) => {
    const method = new URL(input).pathname.split("/").at(-1)!;

    const body = Schema.decodeUnknownSync(
      Schema.Struct({ name: Schema.optionalKey(Schema.String) }),
    )(JSON.parse(String(init.body)));

    if (method === "getUpdates") {
      const batch = pending;
      pending = [];

      if (batch.length === 0) {
        await Bun.sleep(20);
      }

      return Response.json({ ok: true, result: batch });
    }

    calls.push({ method, body: JSON.parse(String(init.body)) });
    const reply = replies.get(method);

    if (reply === "network") {
      throw new TypeError(`fetch failed for ${input}`);
    }

    if (reply !== undefined && "error" in reply) {
      return rejection(reply);
    }

    const defaults = new Map<string, Schema.Json>([
      ["getMe", { id: 100, is_bot: true, username: "PoppetBot" }],
      ["getChat", forum],
      ["getChatMember", { status: "administrator", can_send_messages: true }],
      ["createForumTopic", { message_thread_id: 7, name: body.name ?? "" }],
      ["sendMessage", { message_id: 900 }],
    ]);

    return Response.json({ ok: true, result: reply?.result ?? defaults.get(method) ?? true });
  };

  return { calls, fetcher };
};

const run = <A, E>(
  api: ReturnType<typeof fakeApi>,
  use: (channel: MessagingChannel["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const channel = yield* MessagingChannel;
      yield* channel.accountId;

      return yield* use(channel);
    }).pipe(Effect.provide(telegramChannelLayer(settings, api.fetcher))),
  );

const ownerMessage = (id: number, fields: { [key: string]: Schema.Json }) => ({
  update_id: id,
  message: { message_id: id, chat: forum, from: owner, ...fields },
});

const source: IncomingMessage = {
  messageId: "10",
  scopeId: "-100500",
  parentId: "-100500",
  conversationId: null,
  senderId: "200",
  text: "Hello",
  mentioned: true,
};

describe("telegramChannelLayer", () => {
  test("accepts only the owner's text in the configured chat and maps forum topics", async () => {
    const api = fakeApi([
      ownerMessage(1, {
        text: "@PoppetBot summarise this",
        entities: [{ type: "mention", offset: 0, length: 10 }],
      }),
      { update_id: 2, message: { unexpected: true } },
      ownerMessage(3, {
        text: "/status@poppetbot",
        message_thread_id: 7,
        is_topic_message: true,
        entities: [{ type: "bot_command", offset: 0, length: 17 }],
      }),
      ownerMessage(4, { text: "from someone else", from: { id: 201, is_bot: false } }),
      ownerMessage(5, { text: "from another chat", chat: { id: -100_600, type: "supergroup" } }),
      ownerMessage(6, { text: "from a bot", from: { id: 300, is_bot: true } }),
      ownerMessage(7, {
        text: "unmentioned in a topic",
        message_thread_id: 8,
        is_topic_message: true,
        reply_to_message: {
          message_id: 8,
          chat: forum,
          from: { id: 100, is_bot: true },
          forum_topic_created: { name: "Topic" },
        },
      }),
    ]);

    const received = await run(api, (channel) =>
      channel.messages.pipe(Stream.take(3), Stream.runCollect),
    );

    expect(received).toEqual([
      { ...source, messageId: "1", text: "summarise this" },
      { ...source, messageId: "3", conversationId: "-100500:7", text: "/status" },
      {
        ...source,
        messageId: "7",
        conversationId: "-100500:8",
        text: "unmentioned in a topic",
        mentioned: false,
      },
    ]);
  });

  test("creates, names, and renames a topic, refusing renames over an external edit", async () => {
    const api = fakeApi([]);

    const result = await run(api, (channel) =>
      Effect.gen(function* () {
        const created = yield* channel.naming.conversation(source, "  Trip planning  ");
        const current = yield* channel.naming.current(source, created.id);

        const stale = yield* channel.naming.rename(
          source,
          created.id,
          "Someone else's name",
          "Ignored",
        );

        const renamed = yield* channel.naming.rename(source, created.id, current, "Lisbon trip");

        return { created, current, stale, renamed };
      }),
    );

    expect(result).toEqual({
      created: { id: "-100500:7", managedName: "Trip planning" },
      current: "Trip planning",
      stale: null,
      renamed: "Lisbon trip",
    });

    expect(api.calls.filter((call) => call.method.endsWith("ForumTopic"))).toEqual([
      { method: "createForumTopic", body: { chat_id: -100_500, name: "Trip planning" } },
      {
        method: "editForumTopic",
        body: { chat_id: -100_500, message_thread_id: 7, name: "Lisbon trip" },
      },
    ]);
  });

  test.each(["-100500", "-100500:7"])(
    "reuses conversation %s without creating or claiming its name",
    async (conversationId) => {
      const api = fakeApi([]);

      const result = await run(api, (channel) =>
        channel.naming.conversation({ ...source, conversationId }, "New title"),
      );

      expect(result).toEqual({ id: conversationId, managedName: null });
      expect(api.calls.some((call) => call.method === "createForumTopic")).toBe(false);
    },
  );

  test("reports external topic renames", async () => {
    const api = fakeApi([
      {
        update_id: 1,
        message: {
          message_id: 1,
          chat: forum,
          from: owner,
          message_thread_id: 7,
          forum_topic_edited: { name: "Renamed by owner" },
        },
      },
    ]);

    const result = await run(api, (channel) =>
      Effect.gen(function* () {
        const changed = yield* channel.naming.changes.pipe(Stream.runHead);

        return { changed, name: yield* channel.naming.current(source, "-100500:7") };
      }),
    );

    expect(Option.getOrNull(result.changed)).toBe("-100500:7");
    expect(result.name).toBe("Renamed by owner");
  });

  test("sends to topics and rejects destinations outside the configured chat", async () => {
    const api = fakeApi([]);

    const result = await run(api, (channel) =>
      Effect.gen(function* () {
        const sent = yield* channel.send("-100500:7", "Reply", "nonce");
        const parent = yield* channel.destination("-100500:7");
        const outside = yield* channel.destination("-100600").pipe(Effect.flip);

        return { sent, parent, outside: outside.reason };
      }),
    );

    expect(result).toEqual({ sent: "900", parent: "-100500", outside: "permission" });

    expect(api.calls.find((call) => call.method === "sendMessage")?.body).toEqual({
      chat_id: -100_500,
      text: "Reply",
      link_preview_options: { is_disabled: true },
      message_thread_id: 7,
    });
  });

  test.each([
    ["a rate limit", { error: 429, retryAfter: 3 }, "unavailable", 3000],
    ["a rejected request", { error: 403 }, "permission", 0],
    ["a server error", { error: 502 }, "uncertain", 0],
    ["a network failure", "network", "uncertain", 0],
  ] as const)(
    "classifies %s while sending without exposing the token",
    async (_, reply, reason, retryAfterMs) => {
      const api = fakeApi([], new Map([["sendMessage", reply]]));

      const error = await run(api, (channel) =>
        channel.send("-100500", "Reply", "nonce").pipe(Effect.flip),
      );

      expect({ reason: error.reason, retryAfterMs: error.retryAfterMs }).toEqual({
        reason,
        retryAfterMs,
      });

      expect(JSON.stringify(error)).not.toContain(token);
    },
  );

  test("refuses topics when the chat is not a forum", async () => {
    const api = fakeApi([], new Map([["getChat", { result: { id: -100_500, type: "group" } }]]));

    const error = await run(api, (channel) =>
      channel.checkAccess(source, "-100500:7").pipe(Effect.flip),
    );

    expect(error.reason).toBe("permission");
  });
});
