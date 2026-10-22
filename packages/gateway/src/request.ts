import { SkillName } from "@poppet/store";
import { Effect, Schema } from "effect";

import { ChannelError } from "#src/channel";

/** Selects a fresh session explicitly; ordinary messages keep their existing snapshot. */
export const messagingRequest = (text: string) =>
  Effect.gen(function* () {
    if (!/^\/new(?:\s|$)/.test(text))
      return { fresh: false, prompt: text, skill: null, project: null };

    let prompt = text.slice(4).trim();
    let skill: string | null = null;
    let project: string | null = null;

    while (/^--(?:skill|project)(?:\s|$)/.test(prompt)) {
      const selected = /^--(skill|project)\s+(\S+)\s+([\s\S]+)$/.exec(prompt);

      if (
        !selected ||
        !Schema.is(SkillName)(selected[2]) ||
        (selected[1] === "skill" ? skill !== null : project !== null)
      ) {
        prompt = "";
        break;
      }

      if (selected[1] === "skill") skill = selected[2]!;
      else project = selected[2]!;
      prompt = selected[3]!.trim();
    }

    if (prompt.startsWith("--")) prompt = "";

    if (!prompt)
      return yield* Effect.fail(
        new ChannelError({
          reason: "configuration",
          message:
            "Use /new [--skill <name>] [--project <name>] <message> to start a fresh session.",
        }),
      );

    return { fresh: true, prompt, skill, project };
  });
