import { expect, test } from "bun:test";

import { Redacted, Schema } from "effect";

import { EventBody, escapeSlackText, incomingMessage } from "#src/channel";

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
