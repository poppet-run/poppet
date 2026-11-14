import { SkillName } from "@poppet/store";
import { Effect, Schema } from "effect";

import { ChannelError } from "#src/channel";

export const messagingRequest = (text: string, attached = false) =>
  Effect.gen(function* () {
    if (!/^\/new(?:\s|$)/.test(text)) return { fresh: false, prompt: text, skill: null };

    let prompt = text.slice(4).trim();
    let skill: string | null = null;

    const selected = /^--skill\s+(\S+)\s+([\s\S]+)$/.exec(prompt);

    if (selected && Schema.is(SkillName)(selected[1])) {
      skill = selected[1];
      prompt = selected[2]!.trim();
    }

    if (prompt.startsWith("--") || (!prompt && !attached))
      return yield* Effect.fail(
        new ChannelError({
          reason: "configuration",
          message: "Use /new [--skill <name>] <message> to start a fresh session.",
        }),
      );

    return { fresh: true, prompt, skill };
  });

export const isCommandApproval = (text: string) => /^\/(?:approve|deny)(?:\s|$)/.test(text);

export const isControl = (text: string) =>
  text === "/status" || text === "/cancel" || isCommandApproval(text);
