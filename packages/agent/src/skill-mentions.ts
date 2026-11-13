import type { Message } from "@poppet/provider";
import type { SkillSnapshot } from "@poppet/store";
import { Effect } from "effect";

import { AgentError } from "#src/errors";
import type { Skills } from "#src/skills";

const maxMentions = 4;

// Fenced blocks and inline code are quoted material, where `$name` is usually a shell variable.
const code = /```[\s\S]*?(?:```|$)|`[^`\n]*`/gu;

// `$name` standing alone as a word; `${name}`, `\$name`, `a$name`, `$name/x`, and `$name=1` do not match.
const mention = /(?<=^|[\s("'[])\$([A-Za-z0-9_-]{1,128})(?=[.,;:!?)"'\]]*(?:\s|$))/gu;

/** Distinct `$name` words in a message, in order; whether a skill has that name is decided later. */
export const mentionedSkills = (text: string) => [
  ...new Set(Array.from(text.replace(code, " ").matchAll(mention), (match) => match[1]!)),
];

/**
 * Loads the skills a message names. A name with no skill directory is ordinary text, so pasted
 * shell variables pass through; a named skill that cannot be read fails the request.
 */
export const loadMentionedSkills = (
  skills: Skills["Service"],
  text: string,
  selected: string | null,
): Effect.Effect<ReadonlyArray<SkillSnapshot>, AgentError> =>
  Effect.gen(function* () {
    const candidates = mentionedSkills(text);

    if (candidates.length === 0) return [];

    const listed = new Set(yield* skills.list);
    // The session's selected skill is already supplied from its saved snapshot.
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

/** Renders a user message's saved skills into its text, as the model saw them on the first turn. */
export const withMentionedSkills = (message: Message): Message => {
  if (message.role !== "user" || message.skills === undefined) return message;

  const { skills, ...rest } = message;

  return { ...rest, text: `${message.text}\n\n${guidance}\n${JSON.stringify(skills)}` };
};
