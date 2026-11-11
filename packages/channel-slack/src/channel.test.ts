import { expect, test } from "bun:test";

import { Redacted, Schema } from "effect";

import { EventBody, incomingMessage } from "#src/channel";

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
  text: "<@B123> Hello",
};

test("mentions and thread follow-ups retain source identity for deduplication", () => {
  const first = incomingMessage({ team_id: "T123", event }, settings, "B123")!;
  expect(first).toMatchObject({
    messageId: "C123:123.456",
    text: "Hello",
    mentioned: true,
    conversationId: null,
  });
  expect(
    incomingMessage({ team_id: "T123", event: { ...event, type: "app_mention" } }, settings, "B123")
      ?.messageId,
  ).toBe(first.messageId);
  expect(
    incomingMessage(
      { team_id: "T123", event: { ...event, thread_ts: "100.001", text: "Continue" } },
      settings,
      "B123",
    ),
  ).toMatchObject({ conversationId: "C123:100.001", mentioned: false });
  expect(
    incomingMessage({ team_id: "T123", event: { ...event, channel: "C456" } }, settings, "B123")
      ?.messageId,
  ).not.toBe(first.messageId);
});

test("rejects unauthorized users, workspaces, bot messages, and malformed events", () => {
  expect(incomingMessage({ team_id: "T456", event }, settings, "B123")).toBeNull();

  for (const patch of [
    { user: "U456" },
    { bot_id: "B456" },
    { subtype: "message_changed" },
    { text: "x".repeat(8193) },
  ]) {
    expect(
      incomingMessage({ team_id: "T123", event: { ...event, ...patch } }, settings, "B123"),
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
      "B123",
    ),
  ).toMatchObject({
    text: "",
    attachments: [{ id: "F123", name: "note.txt", ref: "F123", size: 12 }],
  });
});
