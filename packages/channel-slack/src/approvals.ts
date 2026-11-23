import type { ApprovalState, IncomingMessage } from "@poppet/gateway";
import type { KnownBlock } from "@slack/web-api";
import { Schema } from "effect";

import { escapeSlackText } from "#src/channel";
import type { SlackSettings } from "#src/settings";

const prefix = "poppet:approval:";

const labels: Record<ApprovalState, string> = {
  approved: ":white_check_mark: Approved once",
  denied: ":no_entry_sign: Denied",
  expired: "Expired",
  cancelled: "Cancelled",
  unavailable: "No longer available",
};

// Escaping can grow text fivefold, so 600 characters keep each section under Slack's 3000 limit.
const sections = (text: string): Array<KnownBlock> =>
  Array.from({ length: Math.ceil(text.length / 600) || 1 }, (_, index) => ({
    type: "section",
    text: {
      type: "plain_text",
      text: escapeSlackText(text.slice(index * 600, (index + 1) * 600)) || " ",
      emoji: false,
    },
  }));

export const approvalBlocks = (
  text: string,
  id: string,
  state?: ApprovalState,
): Array<KnownBlock> => [
  ...sections(text),
  state
    ? { type: "context", elements: [{ type: "mrkdwn", text: labels[state] }] }
    : {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: `${prefix}approve:${id}`,
            text: { type: "plain_text", text: "Approve once" },
            style: "primary",
          },
          {
            type: "button",
            action_id: `${prefix}deny:${id}`,
            text: { type: "plain_text", text: "Deny" },
            style: "danger",
          },
        ],
      },
];

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
  const action = body.actions.length === 1 ? body.actions[0]!.action_id : "";

  if (!action.startsWith(prefix)) {
    return { kind: "ignored" };
  }

  const match = /^poppet:approval:(approve|deny):([a-f0-9-]{36})$/.exec(action);
  const { channel, message, team, user } = body;
  const thread = message.thread_ts;

  if (
    !match ||
    !botId ||
    team.id !== settings.teamId ||
    user.id !== settings.ownerId ||
    message.user !== botId
  ) {
    return { kind: "rejected", channel: channel.id, user: user.id, ...(thread && { thread }) };
  }

  return {
    kind: "accepted",
    requestId: match[2]!,
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
