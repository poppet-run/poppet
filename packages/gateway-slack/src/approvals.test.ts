import { describe, expect, test } from "bun:test";

import { Redacted } from "effect";

import { approvalBlocks, approvalClick } from "#src/approvals";

const id = "a1234567-1234-1234-1234-123456789012";

const settings = {
  ownerId: "U123",
  teamId: "T123",
  homeChannelId: "C123",
  token: Redacted.make("bot"),
  appToken: Redacted.make("app"),
};

const body = {
  type: "block_actions" as const,
  team: { id: "T123" },
  user: { id: "U123" },
  channel: { id: "C123" },
  message: { ts: "200.002", user: "U999", thread_ts: "100.001" },
  actions: [{ action_id: `poppet:approval:deny:${id}` }],
};

describe("approvalBlocks", () => {
  test("when pending, offers approve and deny buttons for the request", () => {
    const blocks = approvalBlocks("Exact invocation", id);

    expect(blocks.at(-1)).toMatchObject({
      type: "actions",
      elements: [
        { action_id: `poppet:approval:approve:${id}`, style: "primary" },
        { action_id: `poppet:approval:deny:${id}`, style: "danger" },
      ],
    });
  });

  test("when settled, replaces the buttons with the outcome and keeps the invocation", () => {
    const blocks = approvalBlocks("Exact <invocation>", id, "expired");

    expect(blocks).toEqual([
      {
        type: "section",
        text: { type: "plain_text", text: "Exact &lt;invocation&gt;", emoji: false },
      },
      { type: "context", elements: [{ type: "mrkdwn", text: "Expired" }] },
    ]);
  });

  test("when escaping expands a long invocation, keeps every section within Slack's limit", () => {
    const blocks = approvalBlocks("&".repeat(3000), id);

    const lengths = blocks.flatMap((block) =>
      block.type === "section" ? [block.text?.text.length ?? 0] : [],
    );

    expect(lengths).toHaveLength(5);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(3000);
  });
});

describe("approvalClick", () => {
  test("when the owner clicks a bot prompt in a thread, identifies the prompt and conversation", () => {
    expect(approvalClick(body, settings, "U999")).toEqual({
      kind: "accepted",
      requestId: id,
      decision: "deny",
      thread: "100.001",
      source: {
        messageId: "200.002",
        scopeId: "T123",
        parentId: "C123",
        conversationId: "C123:100.001",
        senderId: "U123",
        text: "",
        mentioned: false,
      },
    });
  });

  test.each([
    ["another user", { user: { id: "U456" } }],
    ["another workspace", { team: { id: "T456" } }],
    ["a message not posted by the bot", { message: { ts: "200.002", user: "U456" } }],
    ["a malformed request ID", { actions: [{ action_id: "poppet:approval:approve:invalid" }] }],
  ])("when the click comes from %s, rejects it", (_, patch) => {
    expect(approvalClick({ ...body, ...patch }, settings, "U999")).toMatchObject({
      kind: "rejected",
      channel: "C123",
    });
  });

  test("when the action belongs to another component, ignores it", () => {
    expect(
      approvalClick({ ...body, actions: [{ action_id: "unrelated" }] }, settings, "U999"),
    ).toEqual({ kind: "ignored" });
  });
});
