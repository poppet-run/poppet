import { describe, expect, test } from "bun:test";

import { formatApprovalPrompt, GatewayAdapter } from "@poppet/gateway";
import { Effect, Option, Redacted, Stream } from "effect";
import type { Schema } from "effect";

import { telegramAdapterLayer } from "#src/adapter";
import {
  approvalCallback,
  approvalDetailsHtml,
  approvalHtml,
  approvalMarkup,
  settledMarkup,
} from "#src/approvals";

const id = "a1234567-1234-1234-1234-123456789012";

const settings = {
  ownerId: "200",
  chatId: "-100500",
  homeConversationId: "-100500",
  token: Redacted.make("123456:telegram-secret"),
};

const bashPrompt = formatApprovalPrompt({
  requestId: id,
  approval: {
    kind: "bash",
    command: String.raw`printf '%s\n' 'a < b & c > d'`,
    cwd: "/tmp",
    timeoutSeconds: 10,
    reason: "Print <test> & verify",
  },
  expiresAt: 1_700_000_120_000,
  expiresAfterSeconds: 120,
});

const longPrompt = formatApprovalPrompt({
  requestId: id,
  approval: {
    kind: "bash",
    command: "echo hello\n".repeat(300),
    cwd: "/tmp",
    timeoutSeconds: 10,
    reason: "Print many lines",
  },
  expiresAt: 1_700_000_120_000,
  expiresAfterSeconds: 120,
});

const query = {
  id: "cb-1",
  from: { id: 200, is_bot: false, username: "owner" },
  message: {
    message_id: 900,
    message_thread_id: 7,
    is_topic_message: true,
    chat: { id: -100_500, type: "supergroup", is_forum: true },
    from: { id: 100, is_bot: true, username: "PoppetBot" },
  },
  data: `poppet:d:${id}`,
};

describe("approvalHtml", () => {
  test("when pending, renders escaped HTML code blocks without text command fallback", () => {
    const html = approvalHtml(bashPrompt);

    expect(html).toContain("<b>Bash approval required</b>");
    expect(html).toContain("<b>Reason:</b> Print &lt;test&gt; &amp; verify");
    expect(html).toContain('<pre><code class="language-sh">');
    expect(html).toContain("a &lt; b &amp; c &gt; d");
    expect(html).toContain("<b>Working directory:</b> <code>/tmp</code>");
    expect(html).toContain("<b>Timeout:</b> 10 seconds");
    expect(html).toContain("Expires in 2 minutes · Permits one execution only");
    expect(html).not.toContain(`/approve ${id}`);
    expect(html).not.toContain(`/deny ${id}`);
  });

  test("when settled, replaces expiry and fallback with the settled status", () => {
    const html = approvalHtml(bashPrompt, {
      state: "denied",
      settlement: { senderId: "200", text: "Denied" },
    });

    expect(html).toContain("⛔ <b>Denied</b>");
    expect(html).not.toContain(`/approve ${id}`);
  });

  test("when canonical payload is long, splits details HTML into messages under Telegram's limit", () => {
    const parts = approvalDetailsHtml("&".repeat(2000));

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 4096)).toBe(true);
  });
});

describe("approvalMarkup", () => {
  test("when not truncated, includes approve and deny inline buttons within Telegram's callback_data limit", () => {
    const markup = approvalMarkup(id, false);

    expect(markup).toEqual({
      inline_keyboard: [
        [
          { text: "Approve once", callback_data: `poppet:a:${id}` },
          { text: "Deny", callback_data: `poppet:d:${id}` },
        ],
      ],
    });
    expect(`poppet:a:${id}`.length).toBeLessThanOrEqual(64);
  });

  test("when truncated, adds a Show details button row", () => {
    expect(approvalMarkup(id, true)).toEqual({
      inline_keyboard: [
        [
          { text: "Approve once", callback_data: `poppet:a:${id}` },
          { text: "Deny", callback_data: `poppet:d:${id}` },
        ],
        [{ text: "Show details", callback_data: `poppet:s:${id}` }],
      ],
    });
  });
});

describe("approvalCallback", () => {
  test("when the owner taps a bot button in a forum topic, maps the conversation and decision", () => {
    expect(approvalCallback(query, settings, 100)).toEqual({
      kind: "accepted",
      queryId: "cb-1",
      requestId: id,
      decision: "deny",
      source: {
        messageId: "900",
        scopeId: "-100500",
        parentId: "-100500",
        conversationId: "-100500:7",
        senderId: "200",
        text: "",
        mentioned: false,
      },
    });
  });

  test("when the owner taps Show details, returns a details action", () => {
    expect(approvalCallback({ ...query, data: `poppet:s:${id}` }, settings, 100)).toEqual({
      kind: "details",
      queryId: "cb-1",
      requestId: id,
      threadId: 7,
    });
  });

  test.each([
    ["another user", { from: { id: 201, is_bot: false } }],
    ["a bot user", { from: { id: 200, is_bot: true } }],
    ["another chat", { message: { ...query.message, chat: { id: -100_600, type: "supergroup" } } }],
    [
      "another sender's message",
      { message: { ...query.message, from: { id: 999, is_bot: true } } },
    ],
    ["a malformed callback", { data: "poppet:a:invalid" }],
  ])("when the callback comes from %s, rejects it", (_, patch) => {
    expect(approvalCallback({ ...query, ...patch }, settings, 100)).toEqual({
      kind: "rejected",
      queryId: "cb-1",
    });
  });

  test("when the callback belongs to another component, ignores it", () => {
    expect(approvalCallback({ ...query, data: "other:action" }, settings, 100)).toEqual({
      kind: "ignored",
    });
  });
});

describe("Telegram approval adapter", () => {
  test("when sending, answering, and settling an approval, uses HTML, inline buttons, and editMessageText", async () => {
    const calls: Array<{ method: string; body: Schema.Json }> = [];
    let pending: Array<Schema.Json> = [{ update_id: 1, callback_query: query }];

    const fetcher = async (input: string, init: RequestInit) => {
      const method = new URL(input).pathname.split("/").at(-1)!;
      const body = JSON.parse(String(init.body));

      if (method === "getUpdates") {
        const batch = pending;
        pending = [];

        if (batch.length === 0) {
          await Bun.sleep(20);
        }

        return Response.json({ ok: true, result: batch });
      }

      calls.push({ method, body });

      if (method === "getMe") {
        return Response.json({
          ok: true,
          result: { id: 100, is_bot: true, username: "PoppetBot" },
        });
      }

      if (method === "sendMessage") {
        return Response.json({ ok: true, result: { message_id: 900 } });
      }

      return Response.json({ ok: true, result: true });
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const channel = yield* GatewayAdapter;
        yield* channel.accountId;

        expect(yield* channel.approvals!.send("-100500:7", longPrompt, "nonce")).toBe("900");
        expect(calls.at(-1)).toEqual({
          method: "sendMessage",
          body: expect.objectContaining({
            chat_id: -100_500,
            message_thread_id: 7,
            parse_mode: "HTML",
            reply_markup: approvalMarkup(id, true),
          }),
        });

        const action = Option.getOrThrow(yield* Stream.runHead(channel.approvals!.actions));
        expect(action.requestId).toBe(id);
        expect(action.decision).toBe("deny");
        yield* action.reply("Command denied.");
        expect(calls.at(-1)).toEqual({
          method: "answerCallbackQuery",
          body: { callback_query_id: "cb-1", text: "Command denied." },
        });

        yield* channel.approvals!.update("-100500:7", "900", id, "denied", {
          senderId: "200",
          text: "Denied",
        });
        expect(calls.at(-1)).toEqual({
          method: "editMessageText",
          body: expect.objectContaining({
            chat_id: -100_500,
            message_id: 900,
            parse_mode: "HTML",
            reply_markup: settledMarkup,
          }),
        });
      }).pipe(Effect.provide(telegramAdapterLayer(settings, fetcher))),
    );
  });
});
