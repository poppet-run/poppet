import { describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";

import { MessagingChannel } from "@poppet/gateway";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { Deferred, Effect, Fiber, Redacted, Schema } from "effect";

import {
  EventBody,
  allowedSlackChannel,
  escapeSlackText,
  incomingMessage,
  slackChannelLayer,
  slackSocketSession,
} from "#src/channel";

const settings = {
  ownerId: "U123",
  teamId: "T123",
  homeChannelId: "C123",
  token: Redacted.make("bot"),
  appToken: Redacted.make("app"),
};

const event = {
  type: "message" as const,
  user: "U123",
  channel: "C123",
  ts: "123.456",
  text: "<@U999> Hello",
};

test("mentions and thread follow-ups retain source identity for deduplication", () => {
  const first = incomingMessage({ team_id: "T123", event }, settings, "U999")!;
  expect(first).toMatchObject({
    messageId: "C123:123.456",
    text: "Hello",
    mentioned: true,
    conversationId: null,
  });
  expect(
    incomingMessage(
      { team_id: "T123", event: { ...event, thread_ts: "100.001", text: "Continue" } },
      settings,
      "U999",
    ),
  ).toMatchObject({ conversationId: "C123:100.001", mentioned: false });
  expect(
    incomingMessage({ team_id: "T123", event: { ...event, channel: "C456" } }, settings, "U999")
      ?.messageId,
  ).not.toBe(first.messageId);
});

test("rejects unauthorized users, workspaces, bot messages, and malformed events", () => {
  expect(incomingMessage({ team_id: "T456", event }, settings, "U999")).toBeNull();

  for (const patch of [
    { user: "U456" },
    { bot_id: "B456" },
    { subtype: "message_changed" },
    { text: "x".repeat(8193) },
  ]) {
    expect(
      incomingMessage({ team_id: "T123", event: { ...event, ...patch } }, settings, "U999"),
    ).toBeNull();
  }

  expect(Schema.is(EventBody)({ team_id: "T123", event: { ...event, channel: "D123" } })).toBe(
    false,
  );
});

test("file-share messages retain file IDs without trusting event download URLs", () => {
  expect(
    incomingMessage(
      {
        team_id: "T123",
        event: {
          ...event,
          text: "",
          subtype: "file_share",
          files: [{ id: "F123", name: "note.txt", size: 12 }],
        },
      },
      settings,
      "U999",
    ),
  ).toMatchObject({
    text: "",
    attachments: [{ id: "F123", name: "note.txt", ref: "F123", size: 12 }],
  });
});

test("decodes incoming entities once and escapes reply markup", () => {
  expect(
    incomingMessage(
      {
        team_id: "T123",
        event: { ...event, text: "<@U999> a &lt; b &amp;&amp; b &gt; c &amp;lt;" },
      },
      settings,
      "U999",
    )?.text,
  ).toBe("a < b && b > c &lt;");
  expect(escapeSlackText("<!channel> <@U123> a & b")).toBe(
    "&lt;!channel&gt; &lt;@U123&gt; a &amp; b",
  );
});

test("caps file counts and names without dropping the message", () => {
  const files = Array.from({ length: 11 }, (_, i) => ({ id: `F${i}`, name: "x".repeat(1100) }));

  const message = incomingMessage(
    { team_id: "T123", event: { ...event, files } },
    settings,
    "U999",
  );

  expect(message?.attachments).toHaveLength(10);
  expect(message?.attachments?.[0]?.name).toHaveLength(1024);
});

test.each(["is_im", "is_mpim", "is_org_shared", "is_pending_ext_shared"] as const)(
  "when Slack reports %s, rejects the conversation even if the bot is a member",
  (flag) => {
    expect(allowedSlackChannel({ is_member: true, [flag]: true })).toBe(false);
    expect(allowedSlackChannel({ is_member: true, is_private: true })).toBe(true);
  },
);

test("when a Slack socket closes, reports it offline and releases its connection attempt", async () => {
  const socket = Object.assign(new EventEmitter(), { start: async () => ({ ok: true }) });
  const changes: boolean[] = [];

  await Effect.runPromise(
    Effect.gen(function* () {
      const online = yield* Deferred.make<void>();

      const fiber = yield* slackSocketSession(socket, (connected) => {
        changes.push(connected);

        if (connected) Deferred.doneUnsafe(online, Effect.void);
      }).pipe(Effect.forkChild);

      yield* Deferred.await(online);
      socket.emit("close");
      yield* Fiber.join(fiber);
    }),
  );

  expect(changes).toEqual([true, false]);
});

describe("slackChannelLayer", () => {
  test("when Slack acknowledges a later event, clears the earlier acknowledgement error", async () => {
    const started = Promise.withResolvers<SocketModeClient>();

    const api = spyOn(WebClient.prototype, "apiCall").mockImplementation(async (method) => {
      if (method !== "auth.test") throw new Error("Unexpected Slack request");

      return { ok: true, team_id: settings.teamId, user_id: "U999" };
    });

    const start = spyOn(SocketModeClient.prototype, "start").mockImplementation(async function (
      this: SocketModeClient,
    ) {
      this.emit("connected");
      started.resolve(this);

      return { ok: true };
    });

    const disconnect = spyOn(SocketModeClient.prototype, "disconnect").mockResolvedValue();

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const channel = yield* MessagingChannel;
          const socket = yield* Effect.promise(() => started.promise);
          const input = { type: "events_api", body: { team_id: settings.teamId, event } };

          socket.emit("slack_event", {
            ...input,
            ack: async () => {
              throw new Error("Disconnected");
            },
          });
          yield* Effect.promise(() => setImmediate());
          expect(yield* channel.status).toHaveProperty(
            "error",
            "Slack event acknowledgement failed.",
          );

          socket.emit("slack_event", { ...input, ack: async () => undefined });
          yield* Effect.promise(() => setImmediate());
          expect(yield* channel.status).toHaveProperty("error", null);
        }).pipe(Effect.provide(slackChannelLayer(settings))),
      );
    } finally {
      disconnect.mockRestore();
      start.mockRestore();
      api.mockRestore();
    }
  });
});
