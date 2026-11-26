import { formatApprovalDuration, formatApprovalStatus } from "@poppet/gateway";
import type {
  ApprovalPrompt,
  ApprovalSettlement,
  ApprovalState,
  IncomingMessage,
} from "@poppet/gateway";
import type { Button, KnownBlock } from "@slack/web-api";
import { Schema } from "effect";

import { escapeSlackText } from "#src/adapter";
import type { SlackSettings } from "#src/settings";

const prefix = "poppet:approval:";

const safeSlack = (text: string, maxLength: number) => {
  const escaped = escapeSlackText(text);

  if (escaped.length <= maxLength) {
    return escaped;
  }

  let end = Math.max(0, Math.floor((maxLength - 1) / 5));

  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) {
    end--;
  }

  return `${escapeSlackText(text.slice(0, end))}…`;
};

export const slackSettlementText = (
  state: ApprovalState,
  settlement?: ApprovalSettlement,
): string => {
  switch (state) {
    case "approved":
      return settlement?.senderId
        ? `:white_check_mark: Approved by <@${settlement.senderId}>`
        : `:white_check_mark: ${settlement?.text ?? formatApprovalStatus(state)}`;
    case "denied":
      return settlement?.senderId
        ? `:no_entry_sign: Denied by <@${settlement.senderId}>`
        : `:no_entry_sign: ${settlement?.text ?? formatApprovalStatus(state)}`;
    case "expired":
      return `:hourglass: ${settlement?.text ?? formatApprovalStatus(state)}`;
    case "cancelled":
    case "unavailable":
      return settlement?.text ?? formatApprovalStatus(state);
  }
};

export const settledFallbackBlocks = (
  state: ApprovalState,
  settlement?: ApprovalSettlement,
): Array<KnownBlock> => [
  { type: "context", elements: [{ type: "mrkdwn", text: slackSettlementText(state, settlement) }] },
];

// Escaping can grow text fivefold, so 550 characters keep each code block under Slack's 3000 limit.
export const approvalDetailsBlocks = (payload: string): Array<KnownBlock> =>
  Array.from({ length: Math.ceil(payload.length / 550) || 1 }, (_, index) => ({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `\`\`\`\n${escapeSlackText(payload.slice(index * 550, (index + 1) * 550)) || " "}\n\`\`\``,
    },
  }));

export const approvalBlocks = (
  prompt: ApprovalPrompt,
  settled?: { readonly state: ApprovalState; readonly settlement?: ApprovalSettlement },
): Array<KnownBlock> => {
  const blocks: Array<KnownBlock> = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: prompt.title.slice(0, 150),
        emoji: false,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Reason:* ${safeSlack(prompt.summary, 2900)}`,
      },
    },
  ];

  if (prompt.codeBlock) {
    const note = prompt.codeBlock.truncated
      ? "\n_Truncated — click Show details for the full payload._"
      : "";

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${safeSlack(prompt.codeBlock.label, 100)}*\n\`\`\`\n${safeSlack(prompt.codeBlock.content, 2750)}\n\`\`\`${note}`,
      },
    });
  }

  if (prompt.fields.length > 0) {
    blocks.push({
      type: "section",
      fields: prompt.fields.slice(0, 10).map((field) => ({
        type: "mrkdwn",
        text: `*${safeSlack(field.label, 100)}*\n${field.code ? `\`${safeSlack(field.value, 1800)}\`` : safeSlack(field.value, 1800)}`,
      })),
    });
  }

  if (prompt.args && prompt.args.length > 0) {
    const lines = prompt.args.map(
      (arg) => `• *${safeSlack(arg.key, 80)}*: \`${safeSlack(arg.value, 220)}\``,
    );

    if (prompt.omittedArgsCount && prompt.omittedArgsCount > 0) {
      lines.push(`• _${prompt.omittedArgsCount} more omitted_`);
    }

    const joined = lines.join("\n");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Arguments*\n${joined.length <= 2950 ? joined : `${joined.slice(0, 2949)}…`}`,
      },
    });
  }

  if (settled) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: slackSettlementText(settled.state, settled.settlement) }],
    });
  } else {
    const unixSeconds = Math.floor(prompt.expiresAt / 1000);
    const fallbackExpiry = formatApprovalDuration(prompt.expiresAfterSeconds);

    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Expires <!date^${unixSeconds}^{ago}|in ${fallbackExpiry}> · Permits one execution only`,
        },
      ],
    });

    const buttons: Array<Button> = [
      {
        type: "button",
        action_id: `${prefix}approve:${prompt.requestId}`,
        text: { type: "plain_text", text: "Approve once" },
        style: "primary",
      },
      {
        type: "button",
        action_id: `${prefix}deny:${prompt.requestId}`,
        text: { type: "plain_text", text: "Deny" },
        style: "danger",
      },
    ];

    if (prompt.truncated) {
      buttons.push({
        type: "button",
        action_id: `${prefix}details:${prompt.requestId}`,
        text: { type: "plain_text", text: "Show details" },
      });
    }

    blocks.push({
      type: "actions",
      elements: buttons,
    });
  }

  return blocks;
};

const Timestamp = Schema.String.check(Schema.isPattern(/^\d+\.\d+$/));

export const ActionBody = Schema.Struct({
  type: Schema.Literal("block_actions"),
  team: Schema.Struct({ id: Schema.String }),
  user: Schema.Struct({ id: Schema.String }),
  channel: Schema.Struct({ id: Schema.String.check(Schema.isPattern(/^[CG][A-Z0-9]+$/)) }),
  message: Schema.Struct({
    ts: Timestamp,
    user: Schema.optionalKey(Schema.String),
    thread_ts: Schema.optionalKey(Timestamp),
  }),
  actions: Schema.Array(Schema.Struct({ action_id: Schema.String })),
});

export type ApprovalClick =
  | { readonly kind: "ignored" }
  | {
      readonly kind: "rejected";
      readonly channel: string;
      readonly user: string;
      readonly thread?: string;
    }
  | {
      readonly kind: "details";
      readonly requestId: string;
      readonly channel: string;
      readonly user: string;
      readonly thread?: string;
    }
  | {
      readonly kind: "accepted";
      readonly requestId: string;
      readonly decision: "approve" | "deny";
      readonly source: IncomingMessage;
      readonly thread?: string;
    };

export const approvalClick = (
  body: typeof ActionBody.Type,
  settings: SlackSettings,
  botId: string,
): ApprovalClick => {
  const action = body.actions.length === 1 ? (body.actions[0]?.action_id ?? "") : "";

  if (!action.startsWith(prefix)) {
    return { kind: "ignored" };
  }

  const match = /^poppet:approval:(approve|deny|details):([a-f0-9-]{36})$/.exec(action);
  const requestId = match?.[2];
  const { channel, message, team, user } = body;
  const thread = message.thread_ts;

  if (
    !match ||
    requestId === undefined ||
    !botId ||
    team.id !== settings.teamId ||
    user.id !== settings.ownerId ||
    message.user !== botId
  ) {
    return { kind: "rejected", channel: channel.id, user: user.id, ...(thread && { thread }) };
  }

  if (match[1] === "details") {
    return {
      kind: "details",
      requestId,
      channel: channel.id,
      user: user.id,
      ...(thread && { thread }),
    };
  }

  return {
    kind: "accepted",
    requestId,
    decision: match[1] === "approve" ? "approve" : "deny",
    source: {
      messageId: message.ts,
      scopeId: team.id,
      parentId: channel.id,
      conversationId: thread ? `${channel.id}:${thread}` : channel.id,
      senderId: user.id,
      text: "",
      mentioned: false,
    },
    ...(thread && { thread }),
  };
};
