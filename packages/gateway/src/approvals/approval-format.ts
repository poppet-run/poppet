import { deriveApprovalRule, describeApprovalRule } from "@poppet/agent";
import type { ActionApproval } from "@poppet/agent";
import { Schema } from "effect";

import type { ApprovalState } from "#src/adapter";
import { chunks } from "#src/pipeline/replies";

const MAX_CODE_BLOCK_CHARS = 1200;
const MAX_FIELD_CHARS = 500;
const MAX_ARG_VALUE_CHARS = 200;
const MAX_DISPLAY_ARGS = 10;

// oxlint-disable-next-line no-control-regex
const INLINE_UNSAFE = /[`\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;

const BLOCK_UNSAFE =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;

const FENCE_RUN = /`{3,}/gu;
const JSON_UNSAFE = /[`\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;

const escapeChar = (character: string) =>
  `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;

export const escapeApprovalInline = (text: string) => text.replaceAll(INLINE_UNSAFE, escapeChar);

export const escapeApprovalCodeBlock = (text: string) =>
  text
    .replaceAll(BLOCK_UNSAFE, escapeChar)
    .replaceAll(FENCE_RUN, (run) => String.raw`\u0060`.repeat(run.length));

const escapeApprovalJsonString = (text: string) => text.replaceAll(JSON_UNSAFE, escapeChar);

const truncateText = (text: string, limit: number) => {
  if (text.length <= limit) {
    return { text, truncated: false };
  }

  let end = Math.max(0, limit - 1);

  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) {
    end--;
  }

  return { text: `${text.slice(0, end)}…`, truncated: true };
};

export const formatApprovalDuration = (seconds: number) => {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;

    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }

  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
};

export const formatApprovalStatus = (state: ApprovalState) => {
  switch (state) {
    case "approved":
      return "Approved once";
    case "denied":
      return "Denied";
    case "expired":
      return "Expired";
    case "cancelled":
      return "Cancelled";
    case "superseded":
      return "Superseded by a newer message";
    case "unavailable":
      return "No longer available";
  }
};

export interface ApprovalField {
  readonly label: string;
  readonly value: string;
  readonly code?: boolean;
  readonly inline?: boolean;
}

export interface ApprovalCodeBlock {
  readonly label: string;
  readonly language: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface ApprovalArgument {
  readonly key: string;
  readonly value: string;
  readonly truncated: boolean;
}

export interface ApprovalPrompt {
  readonly requestId: string;
  readonly kind: ActionApproval["kind"];
  readonly title: string;
  readonly summary: string;
  readonly fields: ReadonlyArray<ApprovalField>;
  readonly codeBlock?: ApprovalCodeBlock;
  readonly args?: ReadonlyArray<ApprovalArgument>;
  readonly omittedArgsCount?: number;
  readonly expiresAt: number;
  readonly expiresAfterSeconds: number;
  readonly alwaysAllow?: string;
  readonly canonicalPayload: string;
  readonly truncated: boolean;
  readonly fallbackText: string;
}

const McpInvocation = Schema.Struct({
  server: Schema.String,
  tool: Schema.String,
  origin: Schema.optionalKey(Schema.NullOr(Schema.String)),
  arguments: Schema.Json,
});

const parseJson = (
  text: string,
): { readonly ok: true; readonly value: Schema.Json } | { readonly ok: false } => {
  try {
    return { ok: true, value: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(text) };
  } catch {
    return { ok: false };
  }
};

const isJsonObject = Schema.is(Schema.JsonObject);
const isString = Schema.is(Schema.String);

const formatArgValue = (value: Schema.Json) => {
  const raw = isString(value) ? value : JSON.stringify(value);
  const escaped = escapeApprovalInline(raw);

  return truncateText(escaped, MAX_ARG_VALUE_CHARS);
};

export const formatApprovalMarkdown = (prompt: Omit<ApprovalPrompt, "fallbackText">): string => {
  const lines: Array<string> = [prompt.title, `Reason: ${prompt.summary}`];

  if (prompt.codeBlock) {
    lines.push(
      `${prompt.codeBlock.label}:`,
      `\`\`\`${prompt.codeBlock.language}`,
      prompt.codeBlock.content,
      "```",
    );
  }

  for (const field of prompt.fields) {
    lines.push(`${field.label}: ${field.code ? `\`${field.value}\`` : field.value}`);
  }

  if (prompt.args && prompt.args.length > 0) {
    lines.push("Arguments:");

    for (const arg of prompt.args) {
      lines.push(`- ${arg.key}: \`${arg.value}\``);
    }

    if (prompt.omittedArgsCount && prompt.omittedArgsCount > 0) {
      lines.push(`- (${prompt.omittedArgsCount} more omitted)`);
    }
  }

  if (prompt.alwaysAllow !== undefined) {
    lines.push(`Always allow saves: ${prompt.alwaysAllow}`);
  }

  const expiry = formatApprovalDuration(prompt.expiresAfterSeconds);
  lines.push(
    prompt.alwaysAllow !== undefined
      ? `Reply \`/approve ${prompt.requestId}\`, \`/approve-always ${prompt.requestId}\`, or \`/deny ${prompt.requestId}\`. Expires in ${expiry}.`
      : `Reply \`/approve ${prompt.requestId}\` or \`/deny ${prompt.requestId}\`. Expires in ${expiry}; permits one execution only.`,
  );

  return lines.join("\n");
};

export const formatApprovalMessages = (
  prompt: ApprovalPrompt,
  textLimit: number,
): ReadonlyArray<string> => {
  if (prompt.fallbackText.length <= textLimit) {
    return [prompt.fallbackText];
  }

  const expiry = formatApprovalDuration(prompt.expiresAfterSeconds);

  const controls =
    prompt.alwaysAllow !== undefined
      ? `Reply \`/approve ${prompt.requestId}\`, \`/approve-always ${prompt.requestId}\`, or \`/deny ${prompt.requestId}\`. Expires in ${expiry}.`
      : `Reply \`/approve ${prompt.requestId}\` or \`/deny ${prompt.requestId}\`. Expires in ${expiry}; permits one execution only.`;

  const body = prompt.fallbackText.slice(0, prompt.fallbackText.length - controls.length).trimEnd();

  return [...chunks(body, textLimit), controls];
};

export const formatApprovalPrompt = ({
  requestId,
  approval,
  expiresAt,
  expiresAfterSeconds,
}: {
  readonly requestId: string;
  readonly approval: ActionApproval;
  readonly expiresAt: number;
  readonly expiresAfterSeconds: number;
}): ApprovalPrompt => {
  const summaryResult = truncateText(escapeApprovalInline(approval.reason), MAX_FIELD_CHARS);
  const derivedRule = deriveApprovalRule(approval);

  const alwaysAllow =
    derivedRule === null
      ? undefined
      : truncateText(escapeApprovalInline(describeApprovalRule(derivedRule)), MAX_FIELD_CHARS).text;

  if (approval.kind === "bash") {
    const commandResult = truncateText(
      escapeApprovalCodeBlock(approval.command),
      MAX_CODE_BLOCK_CHARS,
    );

    const cwdResult = truncateText(escapeApprovalInline(approval.cwd), MAX_FIELD_CHARS);

    const canonicalPayload = escapeApprovalJsonString(
      JSON.stringify(
        {
          command: approval.command,
          cwd: approval.cwd,
          timeoutSeconds: approval.timeoutSeconds,
        },
        null,
        2,
      ),
    );

    const truncated = summaryResult.truncated || commandResult.truncated || cwdResult.truncated;

    const base: Omit<ApprovalPrompt, "fallbackText"> = {
      requestId,
      kind: "bash",
      title: "Bash approval required",
      summary: summaryResult.text,
      codeBlock: {
        label: "Command",
        language: "sh",
        content: commandResult.text,
        truncated: commandResult.truncated,
      },
      fields: [
        { label: "Working directory", value: cwdResult.text, code: true, inline: true },
        {
          label: "Timeout",
          value: formatApprovalDuration(approval.timeoutSeconds),
          inline: true,
        },
      ],
      expiresAt,
      expiresAfterSeconds,
      ...(alwaysAllow !== undefined && { alwaysAllow }),
      canonicalPayload,
      truncated,
    };

    return { ...base, fallbackText: formatApprovalMarkdown(base) };
  }

  const targetResult = truncateText(escapeApprovalInline(approval.target), MAX_FIELD_CHARS);
  const effectsResult = truncateText(escapeApprovalInline(approval.effects), MAX_FIELD_CHARS);
  const parsed = parseJson(approval.invocation);

  const canonicalPayload = parsed.ok
    ? escapeApprovalJsonString(JSON.stringify(parsed.value, null, 2))
    : escapeApprovalCodeBlock(approval.invocation);

  if (parsed.ok && Schema.is(McpInvocation)(parsed.value)) {
    const serverResult = truncateText(escapeApprovalInline(parsed.value.server), MAX_FIELD_CHARS);
    const toolResult = truncateText(escapeApprovalInline(parsed.value.tool), MAX_FIELD_CHARS);

    const fields: Array<ApprovalField> = [
      { label: "Server", value: serverResult.text, code: true, inline: true },
      { label: "Tool", value: toolResult.text, code: true, inline: true },
    ];

    let originTruncated = false;

    if (isString(parsed.value.origin) && parsed.value.origin.length > 0) {
      const originResult = truncateText(escapeApprovalInline(parsed.value.origin), MAX_FIELD_CHARS);
      originTruncated = originResult.truncated;
      fields.push({ label: "Origin", value: originResult.text, code: true, inline: false });
    }

    fields.push(
      { label: "Target", value: targetResult.text, inline: false },
      { label: "Expected effects", value: effectsResult.text, inline: false },
    );

    let args: Array<ApprovalArgument> | undefined;
    let omittedArgsCount: number | undefined;
    let codeBlock: ApprovalCodeBlock | undefined;
    let argsTruncated = false;

    if (isJsonObject(parsed.value.arguments)) {
      const entries = Object.entries(parsed.value.arguments);

      if (entries.length > 0) {
        args = entries.slice(0, MAX_DISPLAY_ARGS).map(([key, value]) => {
          const formatted = formatArgValue(value);

          if (formatted.truncated) {
            argsTruncated = true;
          }

          return {
            key: escapeApprovalInline(key),
            value: formatted.text,
            truncated: formatted.truncated,
          };
        });

        if (entries.length > MAX_DISPLAY_ARGS) {
          omittedArgsCount = entries.length - MAX_DISPLAY_ARGS;
          argsTruncated = true;
        }
      }
    } else if (parsed.value.arguments !== null) {
      const prettyArgs = escapeApprovalJsonString(JSON.stringify(parsed.value.arguments, null, 2));
      const argBlock = truncateText(prettyArgs, MAX_CODE_BLOCK_CHARS);
      argsTruncated = argBlock.truncated;
      codeBlock = {
        label: "Arguments",
        language: "json",
        content: argBlock.text,
        truncated: argBlock.truncated,
      };
    }

    const truncated =
      summaryResult.truncated ||
      targetResult.truncated ||
      effectsResult.truncated ||
      serverResult.truncated ||
      toolResult.truncated ||
      originTruncated ||
      argsTruncated;

    const base: Omit<ApprovalPrompt, "fallbackText"> = {
      requestId,
      kind: "mcp",
      title: "MCP action approval required",
      summary: summaryResult.text,
      fields,
      ...(codeBlock && { codeBlock }),
      ...(args && { args }),
      ...(omittedArgsCount !== undefined && { omittedArgsCount }),
      expiresAt,
      expiresAfterSeconds,
      ...(alwaysAllow !== undefined && { alwaysAllow }),
      canonicalPayload,
      truncated,
    };

    return { ...base, fallbackText: formatApprovalMarkdown(base) };
  }

  const fallbackBlock = truncateText(canonicalPayload, MAX_CODE_BLOCK_CHARS);

  const base: Omit<ApprovalPrompt, "fallbackText"> = {
    requestId,
    kind: "mcp",
    title: "MCP action approval required",
    summary: summaryResult.text,
    fields: [
      { label: "Target", value: targetResult.text, inline: false },
      { label: "Expected effects", value: effectsResult.text, inline: false },
    ],
    codeBlock: {
      label: "Invocation",
      language: "json",
      content: fallbackBlock.text,
      truncated: fallbackBlock.truncated,
    },
    expiresAt,
    expiresAfterSeconds,
    canonicalPayload,
    truncated:
      summaryResult.truncated ||
      targetResult.truncated ||
      effectsResult.truncated ||
      fallbackBlock.truncated,
  };

  return { ...base, fallbackText: formatApprovalMarkdown(base) };
};
