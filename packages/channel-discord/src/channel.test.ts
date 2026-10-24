import { describe, expect, spyOn, test } from "bun:test";

import { MessagingChannel } from "@poppet/gateway";
import { ChannelType, Client, Events, MessageFlags, Options } from "discord.js";
import { Effect, Option, Redacted, Stream } from "effect";
import { TestClock } from "effect/testing";

import { discordChannelLayer } from "#src/channel";

const user = { id: "100", username: "Poppet", discriminator: "0", avatar: null, bot: true };

const owner = { ...user, id: "200", username: "Owner", bot: false };

const settings = {
  ownerId: owner.id,
  guildId: "500",
  homeChannelId: "300",
  token: Redacted.make("secret-discord-token"),
};

describe("discordChannelLayer", () => {
  test.each(["completed", "stopped"] as const)(
    "when marking %s is rate limited, retries removal without replaying completed reactions",
    async (state) => {
      const writes: string[] = [];
      let removals = 0;
      const ready = spyOn(Client.prototype, "isReady").mockReturnValue(true);

      const login = spyOn(Client.prototype, "login").mockImplementation(async function (
        this: Client,
      ) {
        Object.defineProperty(this, "user", { value: user });
        this.rest.setToken("test-token");
        spyOn(this.rest.options, "makeRequest").mockImplementation(async (url, options) => {
          const path = new URL(url).pathname.replace("/api/v10", "");

          if (options.method === "GET") {
            if (path === "/guilds/500")
              return Response.json({ id: "500", name: "Test", roles: [], members: [] });

            if (path === "/channels/300")
              return Response.json({
                id: "300",
                guild_id: "500",
                type: ChannelType.GuildText,
                permission_overwrites: [],
              });

            if (path === "/channels/300/messages/400")
              return Response.json({
                id: "400",
                channel_id: "300",
                guild_id: "500",
                author: owner,
                content: "Hello",
                mentions: [],
                mention_roles: [],
                attachments: [],
                embeds: [],
                type: 0,
              });
          }

          if (path.startsWith("/channels/300/messages/400/reactions/")) {
            writes.push(`${options.method} ${decodeURIComponent(path.split("/").at(-2)!)}`);

            if (options.method === "DELETE" && ++removals <= 2)
              return Response.json(
                { message: "Rate limited" },
                { status: 429, headers: { "Retry-After": removals === 1 ? "2.1" : "0.001" } },
              );

            return new Response(null, { status: 204 });
          }

          throw new Error(`Unexpected request: ${options.method} ${path}`);
        });
        await this.guilds.fetch("500");

        if (this.isReady()) this.emit(Events.ClientReady, this);

        return "logged-in";
      });

      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const channel = yield* MessagingChannel;
            yield* channel.accountId;

            const incoming = {
              messageId: "400",
              scopeId: "500",
              parentId: "300",
              conversationId: null,
              senderId: "200",
              text: "Hello",
              mentioned: true,
            };

            yield* channel.mark(incoming, "working");
            yield* channel.mark(incoming, state);
            expect(writes).toEqual([
              "PUT 👀",
              ...(state === "completed" ? ["PUT ✅"] : []),
              "DELETE 👀",
              "DELETE 👀",
              "DELETE 👀",
            ]);
          }).pipe(Effect.provide(discordChannelLayer(settings))),
        );
      } finally {
        login.mockRestore();
        ready.mockRestore();
      }
    },
  );

  test("when Discord messages and threads are processed, recovers creation, filters events, and suppresses reply mentions", async () => {
    const client = new Client({
      intents: [],
      makeCache: Options.cacheWithLimits({ MessageManager: 0 }),
    });

    const login = spyOn(client, "login").mockImplementation(async () => {
      if (client.isReady()) client.emit(Events.ClientReady, client);

      return "logged-in";
    });

    const destroyed = spyOn(client, "destroy").mockResolvedValue();
    const ready = spyOn(client, "isReady").mockReturnValue(true);
    // The adapter only reads identity here; actual guild members below use SDK objects.
    Object.defineProperty(client, "user", { value: user, writable: true });

    const parent = {
      id: "300",
      guild_id: "500",
      name: "private-poppet",
      type: ChannelType.GuildText,
      permission_overwrites: [],
    };

    const thread = {
      id: "400",
      guild_id: "500",
      parent_id: "300",
      owner_id: "200",
      name: "Renamed thread",
      type: ChannelType.PublicThread,
      thread_metadata: {
        archived: true,
        locked: false,
        auto_archive_duration: 1440,
        archive_timestamp: new Date().toISOString(),
      },
    };

    let created = false;
    let loseSend = false;
    let botReacted = false;
    let reportReactions = true;
    let sourceAuthor = owner;

    const source = () => ({
      id: "400",
      channel_id: "300",
      guild_id: "500",
      author: sourceAuthor,
      content: "<@100> Hello",
      mentions: [user],
      mention_roles: [],
      attachments: [],
      embeds: [],
      flags: created ? MessageFlags.HasThread : 0,
      type: 0,
      reactions: reportReactions
        ? [{ count: botReacted ? 2 : 1, me: botReacted, emoji: { id: null, name: "👀" } }]
        : [],
    });

    const get = spyOn(client.rest, "get").mockImplementation(async (route) => {
      if (route === "/guilds/500")
        return {
          id: "500",
          name: "Test",
          owner_id: "100",
          roles: [{ id: "500", name: "@everyone", permissions: "0", position: 0 }],
          members: [{ user, roles: [], joined_at: new Date().toISOString() }],
        };

      if (route === "/channels/300") return parent;

      if (route === "/channels/900") return { ...parent, id: "900" };

      if (route === "/channels/999") return { ...parent, id: "999", guild_id: "999" };

      if (route === "/channels/900/messages/400") return { ...source(), channel_id: "900" };

      if (route === "/channels/400") return thread;

      if (route === "/channels/300/messages/400") return source();

      if (route === "/channels/400/messages/401")
        return {
          ...source(),
          id: "401",
          channel_id: "400",
          content: "Continue",
          mentions: [],
          flags: 0,
        };
      throw new Error(`Unexpected read: ${route}`);
    });

    const post = spyOn(client.rest, "post").mockImplementation(async (route) => {
      if (route === "/channels/400/typing") return;

      if (route === "/channels/300/messages/400/threads") {
        created = true;
        throw new Error("Lost creation acknowledgement");
      }

      if (route === "/channels/300/messages")
        return {
          ...source(),
          id: "601",
          channel_id: "300",
          author: user,
          content: "Scheduled result",
        };

      if (route === "/channels/400/messages") {
        if (loseSend) throw new Error("Lost send acknowledgement");

        return { ...source(), id: "600", channel_id: "400", author: user, content: "Reply" };
      }

      throw new Error(`Unexpected write: ${route}`);
    });

    let loseRename = false;

    const patch = spyOn(client.rest, "patch").mockImplementation(async (route) => {
      if (route !== "/channels/400") throw new Error(`Unexpected rename: ${route}`);
      thread.name = "😀".repeat(50);

      if (loseRename) throw new Error("Lost rename acknowledgement");

      return thread;
    });

    const put = spyOn(client.rest, "put").mockImplementation(async (route) => {
      if (route.endsWith(`/${encodeURIComponent("👀")}/@me`)) botReacted = true;
    });

    const remove = spyOn(client.rest, "delete").mockImplementation(async (route) => {
      if (!route.endsWith(`/${encodeURIComponent("👀")}/@me`))
        throw new Error(`Unexpected reaction removal: ${route}`);

      botReacted = false;
    });

    try {
      const guild = await client.guilds.fetch("500");
      await Effect.runPromise(
        Effect.gen(function* () {
          const channel = yield* MessagingChannel;
          expect(yield* channel.accountId).toBe(user.id);
          expect(yield* channel.status).toMatchObject({ account: user.id, connected: true });

          const incoming = {
            messageId: "400",
            scopeId: "500",
            parentId: "300",
            conversationId: null,
            senderId: "200",
            text: "Hello",
            mentioned: true,
          };

          expect(yield* channel.conversation(incoming).pipe(Effect.result)).toHaveProperty(
            "failure.reason",
            "unavailable",
          );
          expect(yield* channel.conversation(incoming)).toBe("400");
          const naming = channel.naming;

          if (!naming) throw new Error("Missing naming capability");
          // A recovered thread owned by another user is never managed.
          expect(yield* naming.conversation(incoming, "Hello")).toEqual({
            id: "400",
            managedName: null,
          });
          thread.owner_id = "100";
          client.channels.cache.delete("400");
          expect(yield* naming.conversation(incoming, "Hello")).toEqual({
            id: "400",
            managedName: "Hello",
          });
          // Recovering creation retains the intended original name, not a later user edit.
          expect(yield* naming.current(incoming, "400")).toBe("Renamed thread");
          expect(yield* naming.rename(incoming, "400", "Hello", "Generated")).toBeNull();
          expect(patch).not.toHaveBeenCalled();
          thread.name = "Hello";
          expect(yield* naming.rename(incoming, "400", "Hello", "😀".repeat(80))).toBe(
            "😀".repeat(50),
          );
          expect(patch).toHaveBeenCalledWith(
            "/channels/400",
            expect.objectContaining({ body: expect.objectContaining({ name: "😀".repeat(50) }) }),
          );
          thread.name = "Hello";
          loseRename = true;
          expect(
            yield* naming.rename(incoming, "400", "Hello", "😀".repeat(80)).pipe(Effect.result),
          ).toHaveProperty("failure.reason", "uncertain");
          expect(yield* naming.current(incoming, "400")).toBe("😀".repeat(50));
          thread.thread_metadata.locked = true;
          expect(
            yield* naming.rename(incoming, "400", "😀".repeat(50), "Blocked").pipe(Effect.result),
          ).toHaveProperty("failure.reason", "permission");
          thread.thread_metadata.locked = false;

          for (const id of ["invalid", "1".repeat(21)]) {
            expect(yield* channel.destination!(id).pipe(Effect.result)).toHaveProperty(
              "failure.reason",
              "configuration",
            );
          }

          expect(yield* channel.destination!("400")).toBe("300");
          expect(yield* channel.destination!("999").pipe(Effect.result)).toHaveProperty(
            "failure.reason",
            "permission",
          );
          expect(channel.homeConversationId).toBe("300");
          expect(yield* channel.destination!("900")).toBe("900");
          yield* channel.checkAccess({ ...incoming, parentId: "900" }, "900");
          yield* channel.checkAccess(incoming, "300");
          expect(yield* channel.send("300", "Scheduled result", "scheduled-1")).toBe("601");
          expect(
            yield* channel.send("999", "Forbidden", "foreign").pipe(Effect.result),
          ).toHaveProperty("failure.reason", "permission");
          yield* channel.checkAccess(incoming, "400");
          yield* channel.typing("400");
          expect(post).toHaveBeenCalledWith("/channels/400/typing");
          yield* channel.mark(incoming, "working");
          reportReactions = false;
          yield* channel.mark(incoming, "completed");
          reportReactions = true;
          expect(botReacted).toBe(false);
          expect(put.mock.calls.map(([route]) => route)).toEqual([
            `/channels/300/messages/400/reactions/${encodeURIComponent("👀")}/@me`,
            `/channels/300/messages/400/reactions/${encodeURIComponent("✅")}/@me`,
          ]);
          expect(remove).toHaveBeenCalledWith(
            `/channels/300/messages/400/reactions/${encodeURIComponent("👀")}/@me`,
          );
          const fetched = yield* Effect.promise(() => client.channels.fetch("300"));

          if (fetched?.type !== ChannelType.GuildText) throw new Error("Missing parent");
          const message = yield* Effect.promise(() => fetched.messages.fetch("400"));
          message.webhookId = "700";
          client.emit(Events.MessageCreate, message);
          message.webhookId = null;
          client.emit(Events.MessageCreate, message);
          const received = yield* Stream.runHead(channel.messages);
          expect(Option.getOrNull(received)).toEqual(incoming);
          const other = yield* Effect.promise(() => client.channels.fetch("900"));

          if (other?.type !== ChannelType.GuildText) throw new Error("Missing other channel");
          const otherMessage = yield* Effect.promise(() => other.messages.fetch("400"));
          client.emit(Events.MessageCreate, otherMessage);
          expect(Option.getOrNull(yield* Stream.runHead(channel.messages))).toEqual({
            ...incoming,
            parentId: "900",
          });
          const threadChannel = yield* Effect.promise(() => client.channels.fetch("400"));

          if (!threadChannel?.isThread()) throw new Error("Missing thread");
          const followup = yield* Effect.promise(() => threadChannel.messages.fetch("401"));

          const threadMessage = {
            ...incoming,
            messageId: "401",
            conversationId: "400",
            mentioned: false,
          };

          yield* channel.mark(threadMessage, "working");
          yield* channel.mark(threadMessage, "stopped");
          expect(put.mock.calls.map(([route]) => route).slice(2)).toEqual([
            `/channels/400/messages/401/reactions/${encodeURIComponent("👀")}/@me`,
          ]);
          expect(remove).toHaveBeenLastCalledWith(
            `/channels/400/messages/401/reactions/${encodeURIComponent("👀")}/@me`,
          );
          // Another user's eyes reaction remains after the bot removes its own.
          yield* channel.mark(threadMessage, "stopped");
          expect(remove).toHaveBeenCalledTimes(3);
          sourceAuthor = { ...owner, id: "999" };
          expect(yield* channel.mark(incoming, "completed").pipe(Effect.result)).toHaveProperty(
            "failure.reason",
            "permission",
          );
          sourceAuthor = owner;
          expect(
            yield* channel.mark({ ...incoming, parentId: "999" }, "working").pipe(Effect.result),
          ).toHaveProperty("failure.reason", "permission");
          expect(put).toHaveBeenCalledTimes(3);
          client.emit(Events.MessageCreate, followup);
          expect(Option.getOrNull(yield* Stream.runHead(channel.messages))).toEqual({
            ...incoming,
            messageId: "401",
            conversationId: "400",
            text: "Continue",
            mentioned: false,
          });
          guild.ownerId = "999";
          expect(yield* channel.checkAccess(incoming, "400").pipe(Effect.result)).toHaveProperty(
            "failure.reason",
            "permission",
          );
          expect(yield* channel.checkAccess(incoming, "300").pipe(Effect.result)).toHaveProperty(
            "failure.reason",
            "permission",
          );
          guild.ownerId = "100";
          expect(yield* channel.send("400", "@everyone <@200>", "nonce-1")).toBe("600");
          ready.mockReturnValue(false);
          expect(yield* channel.send("400", "Again", "nonce-2").pipe(Effect.result)).toHaveProperty(
            "failure.reason",
            "unavailable",
          );
          expect(yield* channel.status).toMatchObject({ connected: false });
          ready.mockReturnValue(true);
          yield* channel.send("400", "Again", "nonce-2");
          expect(post.mock.calls.filter(([route]) => route.endsWith("/threads"))).toHaveLength(1);
          expect(post.mock.calls.filter(([route]) => route.endsWith("/messages"))).toHaveLength(3);
          expect(post).toHaveBeenCalledWith(
            "/channels/400/messages",
            expect.objectContaining({
              body: expect.objectContaining({
                allowed_mentions: { parse: [], replied_user: false },
                nonce: "nonce-1",
                enforce_nonce: true,
              }),
            }),
          );
          loseSend = true;
          expect(yield* channel.send("400", "Lost", "nonce-3").pipe(Effect.result)).toHaveProperty(
            "failure.reason",
            "uncertain",
          );
        }).pipe(Effect.provide(discordChannelLayer(settings, () => client))),
      );
      expect(login).toHaveBeenCalledTimes(1);
      expect(destroyed).toHaveBeenCalledTimes(1);
    } finally {
      login.mockRestore();
      destroyed.mockRestore();
      ready.mockRestore();
      get.mockRestore();
      post.mockRestore();
      patch.mockRestore();
      put.mockRestore();
      remove.mockRestore();
    }
  });

  test("when Discord login fails, keeps status available and resolves identity after a successful retry", async () => {
    const client = new Client({ intents: [] });
    const ready = spyOn(client, "isReady").mockReturnValue(false);

    const login = spyOn(client, "login")
      .mockRejectedValueOnce(new Error("secret-discord-token"))
      .mockImplementation(async () => {
        Object.defineProperty(client, "user", { value: user });
        ready.mockReturnValue(true);

        if (client.isReady()) client.emit(Events.ClientReady, client);

        return "logged-in";
      });

    const destroy = spyOn(client, "destroy").mockResolvedValue();

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const channel = yield* MessagingChannel;
          // A rejected login stays inside the adapter; the worker can still inspect status.
          yield* Effect.yieldNow;
          const status = yield* channel.status;
          expect(status).toMatchObject({ connected: false, account: null });
          expect(JSON.stringify(status)).not.toContain("secret-discord-token");
          const result = yield* channel.send("400", "Reply", "nonce").pipe(Effect.result);
          expect(result).toHaveProperty("failure.reason", "unavailable");
          yield* TestClock.adjust("29 seconds");
          expect(login).toHaveBeenCalledTimes(1);
          yield* TestClock.adjust("1 second");
          expect(login).toHaveBeenCalledTimes(2);
          expect(yield* channel.accountId).toBe(user.id);
          expect(yield* channel.status).toMatchObject({
            connected: true,
            account: user.id,
            error: null,
          });
        }).pipe(
          Effect.provide(discordChannelLayer(settings, () => client)),
          Effect.provide(TestClock.layer()),
        ),
      );
      expect(login).toHaveBeenCalledTimes(2);
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      login.mockRestore();
      ready.mockRestore();
      destroy.mockRestore();
    }
  });
});
