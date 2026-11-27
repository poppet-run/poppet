import { describe, expect, test } from "bun:test";

import {
  escapeApprovalCodeBlock,
  escapeApprovalInline,
  formatApprovalDuration,
  formatApprovalMessages,
  formatApprovalPrompt,
  formatApprovalStatus,
} from "#src/approvals/approval-format";

const requestId = "a1234567-1234-1234-1234-123456789012";
const expiresAt = 1_700_000_120_000;

describe("approval-format", () => {
  test("when formatting a Bash approval, builds structured fields, sh code block, and readable markdown", () => {
    const prompt = formatApprovalPrompt({
      requestId,
      approval: {
        kind: "bash",
        command: "ls -la",
        cwd: "/tmp",
        timeoutSeconds: 10,
        reason: "List files",
      },
      expiresAt,
      expiresAfterSeconds: 120,
    });

    expect(prompt.title).toBe("Bash approval required");
    expect(prompt.summary).toBe("List files");
    expect(prompt.codeBlock).toEqual({
      label: "Command",
      language: "sh",
      content: "ls -la",
      truncated: false,
    });
    expect(prompt.fields).toEqual([
      { label: "Working directory", value: "/tmp", code: true, inline: true },
      { label: "Timeout", value: "10 seconds", inline: true },
    ]);
    expect(prompt.truncated).toBe(false);
    expect(JSON.parse(prompt.canonicalPayload)).toEqual({
      command: "ls -la",
      cwd: "/tmp",
      timeoutSeconds: 10,
    });
    expect(prompt.alwaysAllow).toBe('Exact command "ls -la" in /tmp');
    expect(prompt.fallbackText).toBe(
      [
        "Bash approval required",
        "Reason: List files",
        "Command:",
        "```sh",
        "ls -la",
        "```",
        "Working directory: `/tmp`",
        "Timeout: 10 seconds",
        'Always allow saves: Exact command "ls -la" in /tmp',
        `Reply \`/approve ${requestId}\`, \`/approve-always ${requestId}\`, or \`/deny ${requestId}\`. Expires in 2 minutes.`,
      ].join("\n"),
    );
  });

  test("when a Bash approval is unsafe for a saved rule, omits alwaysAllow", () => {
    const prompt = formatApprovalPrompt({
      requestId,
      approval: {
        kind: "bash",
        command: "rm -rf /tmp/test",
        cwd: "/tmp",
        timeoutSeconds: 10,
        reason: "Deletes files",
      },
      expiresAt,
      expiresAfterSeconds: 120,
    });

    expect(prompt.alwaysAllow).toBeUndefined();
    expect(prompt.fallbackText).toContain(
      `Reply \`/approve ${requestId}\` or \`/deny ${requestId}\`. Expires in 2 minutes; permits one execution only.`,
    );
  });

  test("when a Bash approval contains control characters, bidi characters, and code fences, escapes them safely", () => {
    const prompt = formatApprovalPrompt({
      requestId,
      approval: {
        kind: "bash",
        command: "echo ```sh\nrm -rf /\u202e\n```",
        cwd: "/tmp/`evil`\npath",
        timeoutSeconds: 60,
        reason: "`approve`\n\u2066",
      },
      expiresAt,
      expiresAfterSeconds: 60,
    });

    expect(prompt.summary).toBe(String.raw`\u0060approve\u0060\u000a\u2066`);
    expect(prompt.codeBlock?.content).not.toContain("```");
    expect(prompt.codeBlock?.content).toContain(String.raw`\u0060\u0060\u0060sh`);
    expect(prompt.codeBlock?.content).toContain(String.raw`\u202e`);
    expect(prompt.fields[0]?.value).toBe(String.raw`/tmp/\u0060evil\u0060\u000apath`);
    expect(prompt.fields[1]?.value).toBe("1 minute");
  });

  test("when formatting a standard MCP approval, renders labelled fields and truncated key/value arguments", () => {
    const prompt = formatApprovalPrompt({
      requestId,
      approval: {
        kind: "mcp",
        invocation: JSON.stringify({
          server: "github",
          tool: "create_issue",
          origin: "https://api.github.com",
          arguments: {
            repo: "poppet-run/poppet",
            body: "a".repeat(250),
            draft: false,
          },
        }),
        target: "poppet-run/poppet",
        effects: "Creates a public issue",
        reason: "Creates an external record",
      },
      expiresAt,
      expiresAfterSeconds: 120,
    });

    expect(prompt.title).toBe("MCP action approval required");
    expect(prompt.summary).toBe("Creates an external record");
    expect(prompt.fields).toEqual([
      { label: "Server", value: "github", code: true, inline: true },
      { label: "Tool", value: "create_issue", code: true, inline: true },
      { label: "Origin", value: "https://api.github.com", code: true, inline: false },
      { label: "Target", value: "poppet-run/poppet", inline: false },
      { label: "Expected effects", value: "Creates a public issue", inline: false },
    ]);
    expect(prompt.args).toHaveLength(3);
    expect(prompt.args?.[0]).toEqual({
      key: "repo",
      value: "poppet-run/poppet",
      truncated: false,
    });
    expect(prompt.args?.[1]?.truncated).toBe(true);
    expect(prompt.args?.[1]?.value.endsWith("…")).toBe(true);
    expect(prompt.args?.[2]).toEqual({ key: "draft", value: "false", truncated: false });
    expect(prompt.truncated).toBe(true);
    expect(prompt.fallbackText).toContain("Server: `github`");
    expect(prompt.fallbackText).toContain("Tool: `create_issue`");
    expect(prompt.fallbackText).toContain("Arguments:");
  });

  test("when an MCP invocation does not match the standard shape, falls back to pretty-printed truncated JSON", () => {
    const prompt = formatApprovalPrompt({
      requestId,
      approval: {
        kind: "mcp",
        invocation: JSON.stringify({ arguments: { text: "x".repeat(2000) } }),
        target: "Docs/42",
        effects: "Replace the document text",
        reason: "Overwrites an existing record",
      },
      expiresAt,
      expiresAfterSeconds: 120,
    });

    expect(prompt.codeBlock?.label).toBe("Invocation");
    expect(prompt.codeBlock?.language).toBe("json");
    expect(prompt.codeBlock?.truncated).toBe(true);
    expect(prompt.truncated).toBe(true);
    expect(JSON.parse(prompt.canonicalPayload)).toEqual({ arguments: { text: "x".repeat(2000) } });
  });

  test("when formatting messages for a narrow text limit, splits body and keeps controls in the last message", () => {
    const prompt = formatApprovalPrompt({
      requestId,
      approval: {
        kind: "bash",
        command: "echo hello\n".repeat(100),
        cwd: "/tmp",
        timeoutSeconds: 10,
        reason: "Run repeated echo",
      },
      expiresAt,
      expiresAfterSeconds: 120,
    });

    const parts = formatApprovalMessages(prompt, 300);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 300)).toBe(true);
    expect(parts.at(-1)).toContain(`/approve ${requestId}`);
  });

  test.each([
    [1, "1 second"],
    [10, "10 seconds"],
    [60, "1 minute"],
    [120, "2 minutes"],
    [90, "90 seconds"],
  ])("when duration is %d seconds, formats as %s", (seconds, expected) => {
    expect(formatApprovalDuration(seconds)).toBe(expected);
  });

  test("when escaping inline text and code blocks, preserves newlines only in code blocks", () => {
    expect(escapeApprovalInline("a\nb`c\u202e")).toBe(String.raw`a\u000ab\u0060c\u202e`);
    expect(escapeApprovalCodeBlock("a\n`b`\n```c```\u202e")).toBe(
      "a\n`b`\n\\u0060\\u0060\\u0060c\\u0060\\u0060\\u0060\\u202e",
    );
  });

  test("when formatting settlement states, returns human-readable labels", () => {
    expect(formatApprovalStatus("approved")).toBe("Approved once");
    expect(formatApprovalStatus("denied")).toBe("Denied");
    expect(formatApprovalStatus("expired")).toBe("Expired");
    expect(formatApprovalStatus("cancelled")).toBe("Cancelled");
    expect(formatApprovalStatus("unavailable")).toBe("No longer available");
  });
});
