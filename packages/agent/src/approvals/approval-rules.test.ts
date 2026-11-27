import { describe, expect, test } from "bun:test";

import {
  deriveApprovalRule,
  deriveBashRule,
  deriveMCPRule,
  describeApprovalRule,
} from "#src/approvals/approval-rules";

describe("deriveBashRule", () => {
  test("when given a simple command and absolute cwd, derives an exact normalized matcher", () => {
    expect(deriveBashRule("git status --short", "/repo/../repo/sub")).toEqual({
      kind: "bash",
      command: "git status --short",
      cwd: "/repo/sub",
    });

    expect(deriveBashRule("bun run check", "/Users/owner/project")).toEqual({
      kind: "bash",
      command: "bun run check",
      cwd: "/Users/owner/project",
    });
  });

  test.each([
    ["pipe", "ls | wc -l", "/tmp"],
    ["semicolon", "ls; rm -rf /", "/tmp"],
    ["logical and", "git status && echo ok", "/tmp"],
    ["command substitution", "echo $(whoami)", "/tmp"],
    ["backticks", "echo `whoami`", "/tmp"],
    ["redirect", "echo hi > out.txt", "/tmp"],
    ["newline", "git status\necho hi", "/tmp"],
    ["sudo", "sudo systemctl restart app", "/"],
    ["rm", "rm -rf build", "/repo"],
    ["curl", "curl https://example.com", "/tmp"],
    ["bash -c", "bash -c ls", "/tmp"],
    ["python", "python3 script.py", "/repo"],
    ["node inline eval", "node -e console.log(1)", "/repo"],
    ["bun inline eval", "bun --eval 1+1", "/repo"],
    ["env assignment", "FOO=1 git status", "/repo"],
    ["leading whitespace", " git status", "/repo"],
    ["relative cwd", "git status", "relative/path"],
  ])("when given an unsafe command (%s), returns null", (_label, command, cwd) => {
    expect(deriveBashRule(command, cwd)).toBeNull();
  });
});

describe("deriveMCPRule", () => {
  test("when given a server, tool, and origin, derives an MCP matcher", () => {
    expect(deriveMCPRule("github", "create_issue", "https://api.github.com")).toEqual({
      kind: "mcp",
      serverId: "github",
      toolName: "create_issue",
      origin: "https://api.github.com",
    });

    expect(deriveMCPRule("local", "run", null)).toEqual({
      kind: "mcp",
      serverId: "local",
      toolName: "run",
      origin: null,
    });
  });
});

describe("deriveApprovalRule", () => {
  test("when given a valid bash or MCP ActionApproval, derives and describes the rule", () => {
    const bashRule = deriveApprovalRule({
      kind: "bash",
      command: "systemctl restart app",
      cwd: "/",
      timeoutSeconds: 10,
      reason: "Restarts app",
    });

    expect(bashRule).toEqual({
      kind: "bash",
      command: "systemctl restart app",
      cwd: "/",
    });
    expect(describeApprovalRule(bashRule!)).toBe('Exact command "systemctl restart app" in /');

    const mcpRule = deriveApprovalRule({
      kind: "mcp",
      invocation: JSON.stringify({
        server: "github",
        tool: "create_issue",
        origin: "https://api.github.com",
        arguments: { title: "Bug" },
      }),
      target: "issue",
      effects: "creates an issue",
      reason: "Creates an issue",
    });

    expect(mcpRule).toEqual({
      kind: "mcp",
      serverId: "github",
      toolName: "create_issue",
      origin: "https://api.github.com",
    });
    expect(describeApprovalRule(mcpRule!)).toBe(
      "Reviewed MCP tool github/create_issue (https://api.github.com)",
    );
  });

  test("when given malformed MCP invocation JSON, returns null", () => {
    expect(
      deriveApprovalRule({
        kind: "mcp",
        invocation: "{not json",
        target: "x",
        effects: "y",
        reason: "z",
      }),
    ).toBeNull();
  });
});
