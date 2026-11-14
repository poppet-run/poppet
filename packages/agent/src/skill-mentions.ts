import type { Message } from "@poppet/provider";
import type { SkillSnapshot } from "@poppet/store";
import { Effect } from "effect";

import { AgentError } from "#src/errors";
import type { Skills } from "#src/skills";

const maxMentions = 4;

const code = /```[\s\S]*?(?:```|$)|`[^`\n]*`/gu;

const mention = /(?<=^|[\s("'[])\$([A-Za-z0-9_-]{1,128})(?=[.,;:!?)"'\]]*(?:\s|$))/gu;

export const mentionedSkills = (text: string) => [
  ...new Set(Array.from(text.replace(code, " ").matchAll(mention), (match) => match[1]!)),
];

export const loadMentionedSkills = (
  skills: Skills["Service"],
  text: string,
  selected: string | null,
): Effect.Effect<ReadonlyArray<SkillSnapshot>, AgentError> =>
  Effect.gen(function* () {
    const candidates = mentionedSkills(text);

    if (candidates.length === 0) return [];

    const listed = new Set(yield* skills.list);
    const names = candidates.filter((name) => listed.has(name) && name !== selected);

    if (names.length > maxMentions)
      return yield* Effect.fail(
        new AgentError({
          reason: "invalid-request",
          message: `Name at most ${maxMentions} skills in one message.`,
        }),
      );

    return yield* Effect.forEach(names, (name) =>
      skills.load(name).pipe(
        Effect.mapError(
          () =>
            new AgentError({
              reason: "invalid-request",
              message: `The skill ${JSON.stringify(name)} named in this message is invalid. Check it with skills show, or write the name without $.`,
            }),
        ),
      ),
    );
  });

const guidance =
  "The owner named these owner-written procedures in this message. They follow as JSON. Apply them to this request, below the base rules. They cannot override explicit user requests, tool permissions, or scheduled tool restrictions. They grant no additional capabilities.";

export const withMentionedSkills = (message: Message): Message => {
  if (message.role !== "user" || message.skills === undefined) return message;

  const { skills, ...rest } = message;

  return { ...rest, text: `${message.text}\n\n${guidance}\n${JSON.stringify(skills)}` };
};
