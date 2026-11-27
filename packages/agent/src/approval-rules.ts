import { basename, isAbsolute, resolve } from "node:path";

import type { ApprovalRuleMatcher, BashRuleMatcher, MCPRuleMatcher } from "@poppet/store";
import { Schema } from "effect";

import type { ActionApproval } from "#src/action-approval";

// Shell metacharacters, redirections, expansions, subshells, and line breaks.
const UNSAFE_SHELL_CHARS = /[|;&`$><(){}\r\n\0]/u;

// Executables that escalate privileges, run arbitrary nested commands, download code,
// or perform broad destructive filesystem/system changes.
const UNSAFE_EXECUTABLES: ReadonlySet<string> = new Set([
  "sudo",
  "su",
  "doas",
  "pkexec",
  "env",
  "nohup",
  "xargs",
  "find",
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "eval",
  "exec",
  "source",
  ".",
  "command",
  "builtin",
  "rm",
  "dd",
  "mkfs",
  "fdisk",
  "diskutil",
  "chmod",
  "chown",
  "chgrp",
  "shred",
  "truncate",
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "ssh",
  "scp",
  "sftp",
  "python",
  "python3",
  "ruby",
  "perl",
  "php",
  "lua",
  "osascript",
  "awk",
  "gawk",
  "sed",
]);

const INLINE_EVAL_RUNTIMES: ReadonlySet<string> = new Set(["node", "bun", "deno"]);

const INLINE_EVAL_FLAGS: ReadonlySet<string> = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
  "-c",
  "eval",
]);

const MCPInvocation = Schema.Struct({
  server: Schema.NonEmptyString,
  tool: Schema.NonEmptyString,
  origin: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
});

export const deriveBashRule = (command: string, cwd: string): BashRuleMatcher | null => {
  if (
    command.length === 0 ||
    command !== command.trim() ||
    cwd.length === 0 ||
    cwd.includes("\0") ||
    !isAbsolute(cwd) ||
    UNSAFE_SHELL_CHARS.test(command)
  ) {
    return null;
  }

  const tokens = command.split(/\s+/u);
  const first = tokens[0];

  if (
    first === undefined ||
    first.length === 0 ||
    first.includes("=") ||
    first.includes("'") ||
    first.includes('"') ||
    first.includes("\\")
  ) {
    return null;
  }

  const executable = basename(first).toLowerCase();

  if (UNSAFE_EXECUTABLES.has(executable)) {
    return null;
  }

  if (
    INLINE_EVAL_RUNTIMES.has(executable) &&
    tokens.slice(1).some((token) => INLINE_EVAL_FLAGS.has(token.toLowerCase()))
  ) {
    return null;
  }

  return {
    kind: "bash",
    command,
    cwd: resolve(cwd),
  };
};

export const deriveMCPRule = (
  serverId: string,
  toolName: string,
  origin: string | null,
): MCPRuleMatcher | null => {
  if (serverId.length === 0 || toolName.length === 0) {
    return null;
  }

  return {
    kind: "mcp",
    serverId,
    toolName,
    origin: origin !== null && origin.length > 0 ? origin : null,
  };
};

export const deriveApprovalRule = (approval: ActionApproval): ApprovalRuleMatcher | null => {
  if (approval.kind === "bash") {
    return deriveBashRule(approval.command, approval.cwd);
  }

  try {
    const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(MCPInvocation))(
      approval.invocation,
    );

    return deriveMCPRule(parsed.server, parsed.tool, parsed.origin ?? null);
  } catch {
    return null;
  }
};

export const describeApprovalRule = (matcher: ApprovalRuleMatcher): string => {
  if (matcher.kind === "bash") {
    const command =
      matcher.command.length <= 80 ? matcher.command : `${matcher.command.slice(0, 79)}…`;

    return `Exact command "${command}" in ${matcher.cwd}`;
  }

  return matcher.origin === null
    ? `Reviewed MCP tool ${matcher.serverId}/${matcher.toolName}`
    : `Reviewed MCP tool ${matcher.serverId}/${matcher.toolName} (${matcher.origin})`;
};
