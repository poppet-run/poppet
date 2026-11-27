import { formatApprovalDuration, formatApprovalStatus } from "@poppet/gateway";
import type {
  ApprovalPrompt,
  ApprovalSettlement,
  ApprovalState,
  IncomingMessage,
} from "@poppet/gateway";
import type { Schema } from "effect";

import type { CallbackQuery } from "#src/api";
import type { TelegramSettings } from "#src/settings";

const prefix = "poppet:";

export const escapeTelegramHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const safeHtml = (text: string, maxLength: number) => {
  const escaped = escapeTelegramHtml(text);

  if (escaped.length <= maxLength) {
    return escaped;
  }

  let end = Math.max(0, Math.floor((maxLength - 1) / 5));

  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) {
    end--;
  }

  return `${escapeTelegramHtml(text.slice(0, end))}…`;
};

export const telegramSettlementHtml = (
  state: ApprovalState,
  settlement?: ApprovalSettlement,
): string => {
  const label = escapeTelegramHtml(settlement?.text ?? formatApprovalStatus(state));

  switch (state) {
    case "approved":
      return `✅ <b>${label}</b>`;
    case "denied":
      return `⛔ <b>${label}</b>`;
    case "expired":
      return `⏱️ <b>${label}</b>`;
    case "cancelled":
    case "superseded":
    case "unavailable":
      return `<b>${label}</b>`;
  }
};

export const approvalHtml = (
  prompt: ApprovalPrompt,
  settled?: { readonly state: ApprovalState; readonly settlement?: ApprovalSettlement },
): string => {
  const lines: Array<string> = [
    `<b>${safeHtml(prompt.title, 150)}</b>`,
    `<b>Reason:</b> ${safeHtml(prompt.summary, 600)}`,
  ];

  if (prompt.codeBlock) {
    const language = escapeTelegramHtml(prompt.codeBlock.language);
    lines.push(
      `<b>${safeHtml(prompt.codeBlock.label, 100)}:</b>\n<pre><code class="language-${language}">${safeHtml(prompt.codeBlock.content, 1800)}</code></pre>`,
    );

    if (prompt.codeBlock.truncated) {
      lines.push("<i>Truncated — tap Show details for the full payload.</i>");
    }
  }

  for (const field of prompt.fields) {
    const value = field.code
      ? `<code>${safeHtml(field.value, 400)}</code>`
      : safeHtml(field.value, 400);

    lines.push(`<b>${safeHtml(field.label, 100)}:</b> ${value}`);
  }

  if (prompt.args && prompt.args.length > 0) {
    lines.push("<b>Arguments:</b>");

    for (const arg of prompt.args) {
      lines.push(`• <b>${safeHtml(arg.key, 80)}:</b> <code>${safeHtml(arg.value, 220)}</code>`);
    }

    if (prompt.omittedArgsCount && prompt.omittedArgsCount > 0) {
      lines.push(`• <i>${prompt.omittedArgsCount} more omitted</i>`);
    }
  }

  if (settled) {
    lines.push("", telegramSettlementHtml(settled.state, settled.settlement));
  } else {
    if (prompt.alwaysAllow !== undefined) {
      lines.push(`<b>Always allow saves:</b> ${safeHtml(prompt.alwaysAllow, 400)}`);
    }

    const expiry = formatApprovalDuration(prompt.expiresAfterSeconds);
    lines.push(
      "",
      prompt.alwaysAllow !== undefined
        ? `Expires in ${expiry} · Approve once or save a reusable rule`
        : `Expires in ${expiry} · Permits one execution only`,
    );
  }

  return lines.join("\n");
};

// Escaping can grow text fivefold, so 750 characters keep each HTML code block under Telegram's 4096 limit.
export const approvalDetailsHtml = (payload: string): ReadonlyArray<string> =>
  Array.from({ length: Math.ceil(payload.length / 750) || 1 }, (_, index) => {
    const slice = payload.slice(index * 750, (index + 1) * 750);

    return `<pre><code class="language-json">${escapeTelegramHtml(slice) || " "}</code></pre>`;
  });

export const approvalMarkup = (
  requestId: string,
  showDetails = false,
  alwaysAllow = false,
): Schema.JsonObject => ({
  inline_keyboard: [
    [
      { text: "Approve once", callback_data: `${prefix}a:${requestId}` },
      { text: "Deny", callback_data: `${prefix}d:${requestId}` },
    ],
    ...(alwaysAllow || showDetails
      ? [
          [
            ...(alwaysAllow
              ? [{ text: "Always allow", callback_data: `${prefix}w:${requestId}` }]
              : []),
            ...(showDetails
              ? [{ text: "Show details", callback_data: `${prefix}s:${requestId}` }]
              : []),
          ],
        ]
      : []),
  ],
});

export const settledMarkup: Schema.JsonObject = { inline_keyboard: [] };

export type ApprovalCallback =
  | { readonly kind: "ignored" }
  | { readonly kind: "rejected"; readonly queryId: string }
  | {
      readonly kind: "details";
      readonly queryId: string;
      readonly requestId: string;
      readonly threadId: number | null;
    }
  | {
      readonly kind: "accepted";
      readonly queryId: string;
      readonly requestId: string;
      readonly decision: "approve" | "approve-always" | "deny";
      readonly source: IncomingMessage;
    };

export const approvalCallback = (
  query: CallbackQuery,
  settings: TelegramSettings,
  botId: number,
): ApprovalCallback => {
  const data = query.data ?? "";

  if (!data.startsWith(prefix)) {
    return { kind: "ignored" };
  }

  const match = /^poppet:([adsw]):([a-f0-9-]{36})$/.exec(data);
  const requestId = match?.[2];
  const message = query.message;

  if (
    !match ||
    requestId === undefined ||
    query.from.is_bot ||
    String(query.from.id) !== settings.ownerId ||
    message === undefined ||
    String(message.chat.id) !== settings.chatId ||
    message.from?.id !== botId
  ) {
    return { kind: "rejected", queryId: query.id };
  }

  const threadId =
    message.chat.is_forum === true && message.is_topic_message === true
      ? (message.message_thread_id ?? null)
      : null;

  if (match[1] === "s") {
    return { kind: "details", queryId: query.id, requestId, threadId };
  }

  let decision: "approve" | "approve-always" | "deny" = "deny";

  if (match[1] === "w") {
    decision = "approve-always";
  } else if (match[1] === "a") {
    decision = "approve";
  }

  return {
    kind: "accepted",
    queryId: query.id,
    requestId,
    decision,
    source: {
      messageId: String(message.message_id),
      scopeId: settings.chatId,
      parentId: settings.chatId,
      conversationId: threadId === null ? settings.chatId : `${settings.chatId}:${threadId}`,
      senderId: settings.ownerId,
      text: "",
      mentioned: false,
    },
  };
};
