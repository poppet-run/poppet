import { SkillName } from "@poppet/store";
import { Effect, Schema } from "effect";

import { ChannelError } from "#src/channel";

/** Selects a fresh session explicitly; ordinary messages keep their existing snapshot. */
export const messagingRequest = (text: string) =>
  Effect.gen(function* () {
    if (!/^\/new(?:\s|$)/.test(text)) return { fresh: false, prompt: text, skill: null };

    let prompt = text.slice(4).trim();
    let skill: string | null = null;

    while (/^--skill(?:\s|$)/.test(prompt)) {
      const selected = /^--(skill)\s+(\S+)\s+([\s\S]+)$/.exec(prompt);

      if (!selected || !Schema.is(SkillName)(selected[2]) || skill !== null) {
        prompt = "";
        break;
      }

      skill = selected[2]!;
      prompt = selected[3]!.trim();
    }

    if (prompt.startsWith("--")) prompt = "";

    if (!prompt)
      return yield* Effect.fail(
        new ChannelError({
          reason: "configuration",
          message: "Use /new [--skill <name>] <message> to start a fresh session.",
        }),
      );

    return { fresh: true, prompt, skill };
  });

/** Approval replies are owner controls, never prompts for the model. */
export const isCommandApproval = (text: string) => /^\/(?:approve|deny)(?:\s|$)/.test(text);

/** Owner controls answered by the gateway without invoking the model. */
export const isControl = (text: string) =>
  text === "/status" || text === "/cancel" || isCommandApproval(text);
