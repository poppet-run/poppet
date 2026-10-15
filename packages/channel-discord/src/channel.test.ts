import { describe, expect, spyOn, test } from "bun:test";

import { MessagingChannel } from "@poppet/gateway";
import { ChannelType, Client, Events, MessageFlags } from "discord.js";
import { Effect, Option, Redacted, Stream } from "effect";

import { discordChannelLayer } from "#src/channel";

const user = { id: "100", username: "Poppet", discriminator: "0", avatar: null, bot: true };

const owner = { ...user, id: "200", username: "Owner", bot: false };

const settings = {
  version: 1 as const,
  botId: user.id,
  ownerId: owner.id,
  guildId: "500",
  channelIds: ["300"],
  token: Redacted.make("secret-discord-token"),
};

describe("Discord adapter", () => {
  test("uses Discord message/thread objects, recovers thread creation, filters events and suppresses reply mentions", async () => {
    const client = new Client({ intents: [] });
    const login = spyOn(client, "login").mockResolvedValue("logged-in");
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
      reactions: [{ count: botReacted ? 2 : 1, me: botReacted, emoji: { id: null, name: "👀" } }],
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

      if (route === "/channels/400/messages") {
        if (loseSend) throw new Error("Lost send acknowledgement");

        return { ...source(), id: "600", channel_id: "400", author: user, content: "Reply" };
      }

      throw new Error(`Unexpected write: ${route}`);
    });

    const put = spyOn(client.rest, "put").mockImplementation(async (route) => {
      if (route.endsWith(`/${encodeURIComponent("👀")}/@me`)) botReacted = true;
    });

    const remove = spyOn(client.rest, "delete").mockImplementation(async () => {
      botReacted = false;
    });

    try {
      const guild = await client.guilds.fetch("500");
      await Effect.runPromise(
        Effect.gen(function* () {
          const channel = yield* MessagingChannel;
          yield* Effect.yieldNow;

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
          yield* channel.checkAccess(incoming, "400");
          yield* channel.typing("400");
          expect(post).toHaveBeenCalledWith("/channels/400/typing");
          yield* channel.mark(incoming, "working");
          yield* channel.mark(incoming, "completed");
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
          expect(remove).toHaveBeenCalledTimes(2);
          sourceAuthor = { ...owner, id: "999" };
          expect(yield* channel.mark(incoming, "completed").pipe(Effect.result)).toHaveProperty(
            "failure.reason",
            "permission",
          );
          sourceAuthor = owner;
          expect(
            yield* channel.mark({ ...incoming, parentId: "900" }, "working").pipe(Effect.result),
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
          expect(post.mock.calls.filter(([route]) => route.endsWith("/messages"))).toHaveLength(2);
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
      put.mockRestore();
      remove.mockRestore();
    }
  });

  test("keeps failed login inside the adapter and redacts connection errors", async () => {
    const client = new Client({ intents: [] });
    const login = spyOn(client, "login").mockRejectedValue(new Error("secret-discord-token"));
    const destroy = spyOn(client, "destroy").mockResolvedValue();

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const channel = yield* MessagingChannel;
          // A rejected login stays inside the adapter; the worker can still inspect status.
          yield* Effect.yieldNow;
          const status = yield* channel.status;
          expect(status).toMatchObject({ connected: false });
          expect(JSON.stringify(status)).not.toContain("secret-discord-token");
          const result = yield* channel.send("400", "Reply", "nonce").pipe(Effect.result);
          expect(result).toHaveProperty("failure.reason", "unavailable");
        }).pipe(Effect.provide(discordChannelLayer(settings, () => client))),
      );
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      login.mockRestore();
      destroy.mockRestore();
    }
  });
});
