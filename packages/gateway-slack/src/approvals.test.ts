import { describe, expect, test } from "bun:test";

import { formatApprovalPrompt } from "@poppet/gateway";
import { Redacted } from "effect";

import { approvalBlocks, approvalClick, approvalDetailsBlocks } from "#src/approvals";

const id = "a1234567-1234-1234-1234-123456789012";

const settings = {
  ownerId: "U123",
  teamId: "T123",
  homeChannelId: "C123",
  token: Redacted.make("bot"),
  appToken: Redacted.make("app"),
};

const bashPrompt = formatApprovalPrompt({
  requestId: id,
  approval: {
    kind: "bash",
    command: "ls -la",
    cwd: "/tmp",
    timeoutSeconds: 10,
    reason: "List <files> & folders",
  },
  expiresAt: 1_700_000_120_000,
  expiresAfterSeconds: 120,
});

const body = {
  type: "block_actions" as const,
  team: { id: "T123" },
  user: { id: "U123" },
  channel: { id: "C123" },
  message: { ts: "200.002", user: "U999", thread_ts: "100.001" },
  actions: [{ action_id: `poppet:approval:deny:${id}` }],
};

describe("approvalBlocks", () => {
  test("when pending, renders structured mrkdwn blocks, Slack date expiry, and approve/deny buttons", () => {
    const blocks = approvalBlocks(bashPrompt);

    expect(blocks[0]).toEqual({
      type: "header",
      text: { type: "plain_text", text: "Bash approval required", emoji: false },
    });
    expect(blocks[1]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "*Reason:* List &lt;files&gt; &amp; folders" },
    });
    expect(blocks[2]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "*Command*\n```\nls -la\n```" },
    });
    expect(blocks[3]).toEqual({
      type: "section",
      fields: [
        { type: "mrkdwn", text: "*Working directory*\n`/tmp`" },
        { type: "mrkdwn", text: "*Timeout*\n10 seconds" },
      ],
    });
    expect(blocks[4]).toEqual({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Expires <!date^1700000120^{ago}|in 2 minutes> · Permits one execution only",
        },
      ],
    });
    expect(blocks.at(-1)).toMatchObject({
      type: "actions",
      elements: [
        { action_id: `poppet:approval:approve:${id}`, style: "primary" },
        { action_id: `poppet:approval:deny:${id}`, style: "danger" },
      ],
    });
  });

  test("when settled, replaces the buttons with a status context line and mentions the approver", () => {
    const blocks = approvalBlocks(bashPrompt, {
      state: "approved",
      settlement: { senderId: "U123", text: "Approved once" },
    });

    expect(blocks.some((block) => block.type === "actions")).toBe(false);
    expect(blocks.at(-1)).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: ":white_check_mark: Approved by <@U123>" }],
    });
  });

  test("when truncated, adds a Show details button and keeps details blocks within Slack's limit", () => {
    const longPrompt = formatApprovalPrompt({
      requestId: id,
      approval: {
        kind: "bash",
        command: "&".repeat(2000),
        cwd: "/tmp",
        timeoutSeconds: 10,
        reason: "Long command",
      },
      expiresAt: 1_700_000_120_000,
      expiresAfterSeconds: 120,
    });

    const blocks = approvalBlocks(longPrompt);
    const actionsBlock = blocks.at(-1);

    expect(actionsBlock).toMatchObject({
      type: "actions",
      elements: [
        expect.objectContaining({ action_id: `poppet:approval:approve:${id}` }),
        expect.objectContaining({ action_id: `poppet:approval:deny:${id}` }),
        { type: "button", action_id: `poppet:approval:details:${id}` },
      ],
    });

    const detailSections = approvalDetailsBlocks(longPrompt.canonicalPayload);

    const lengths = detailSections.flatMap((block) =>
      block.type === "section" ? [block.text?.text.length ?? 0] : [],
    );

    expect(lengths.length).toBeGreaterThan(1);
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

  test("when the owner clicks Show details, returns a details action", () => {
    expect(
      approvalClick(
        { ...body, actions: [{ action_id: `poppet:approval:details:${id}` }] },
        settings,
        "U999",
      ),
    ).toEqual({
      kind: "details",
      requestId: id,
      channel: "C123",
      user: "U123",
      thread: "100.001",
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
