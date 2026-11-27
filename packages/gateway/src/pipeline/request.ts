import { SkillName } from "@poppet/store";
import { Effect, Schema } from "effect";

import { GatewayError } from "#src/adapter";

export const messagingRequest = (text: string, attached = false) =>
  Effect.gen(function* () {
    const command = text.trim();

    if (!/^\/new(?:\s|$)/.test(command)) {
      return { fresh: false, prompt: text, skill: null };
    }

    let prompt = command.slice(4).trim();
    let skill: string | null = null;

    const selected = /^--skill\s+(\S+)(?:\s+([\s\S]+))?$/.exec(prompt);

    if (selected && Schema.is(SkillName)(selected[1])) {
      skill = selected[1];
      prompt = selected[2]?.trim() ?? "";
    }

    if (prompt.startsWith("--") || (!prompt && !attached)) {
      return yield* Effect.fail(
        new GatewayError({
          reason: "configuration",
          message: "Use /new [--skill <name>] <message> to start a fresh session.",
        }),
      );
    }

    return { fresh: true, prompt, skill };
  });

export const isApprovalReply = (text: string) =>
  /^\/(?:approve|approve-always|deny)(?:\s|$)/.test(text.trim());

export const isApprovalManagement = (text: string) => /^\/approvals(?:\s|$)/.test(text.trim());

export const isControl = (text: string) => {
  const command = text.trim();

  return (
    command === "/status" ||
    command === "/cancel" ||
    isApprovalReply(command) ||
    isApprovalManagement(command)
  );
};
