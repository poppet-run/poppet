import { clip } from "@poppet/io";
import { Effect } from "effect";

import { byteSize } from "#src/context";
import type { AgentError } from "#src/errors";
import type { ChatPolicy } from "#src/settings";
import { isManualOnly, skillAuthorityRule } from "#src/skills/skills";
import type { Skills } from "#src/skills/skills";

const truncate = (text: string, bytes: number) =>
  byteSize(text) <= bytes ? text : `${clip(text, bytes - byteSize("…")).trimEnd()}…`;

export const skillDescription = (content: string, bytes: number) => {
  const lines = content
    .split(/\r?\n/u)
    .slice(isManualOnly(content) ? 1 : 0)
    .map((line) => line.trim());

  const heading = lines.find((line) => line.startsWith("#"))?.replace(/^#+\s*/u, "") ?? "";
  const start = lines.findIndex((line) => line.length > 0 && !line.startsWith("#"));
  const paragraph: Array<string> = [];

  for (const line of start < 0 ? [] : lines.slice(start)) {
    if (line.length === 0 || line.startsWith("#")) {
      break;
    }

    paragraph.push(line);
  }

  const description = [heading, paragraph.join(" ")].filter((part) => part.length > 0).join(": ");

  return truncate(description, bytes);
};

export interface SkillIndexEntry {
  readonly name: string;
  readonly description?: string;
}

export interface SkillIndex {
  readonly skills: ReadonlyArray<SkillIndexEntry>;
  readonly truncated: boolean;
}

const fits = (index: SkillIndex, bytes: number) => byteSize(JSON.stringify(index)) <= bytes;

export const skillIndex = (
  skills: Skills["Service"],
  policy: Pick<ChatPolicy, "skillIndexBytes" | "skillIndexEntries" | "skillDescriptionBytes">,
): Effect.Effect<SkillIndex | null, AgentError> =>
  Effect.gen(function* () {
    const bytes = policy.skillIndexBytes;
    const names = yield* skills.list;

    const loaded = yield* Effect.forEach(names.slice(0, policy.skillIndexEntries), (name) =>
      skills.load(name).pipe(
        Effect.map((skill): SkillIndexEntry | null =>
          isManualOnly(skill.content)
            ? null
            : { name, description: skillDescription(skill.content, policy.skillDescriptionBytes) },
        ),
        Effect.catch(() => Effect.succeed(null)),
      ),
    );

    const entries = loaded.flatMap((entry) => (entry === null ? [] : [entry]));

    if (entries.length === 0) {
      return null;
    }

    const truncated = names.length > policy.skillIndexEntries;
    const full = { skills: entries, truncated };

    if (fits(full, bytes)) {
      return full;
    }

    const bare = entries.map(({ name }) => ({ name }));

    for (let count = bare.length; count > 0; count--) {
      const index = { skills: bare.slice(0, count), truncated: true };

      if (fits(index, bytes)) {
        return index;
      }
    }

    return null;
  });

export const skillIndexGuidance = (selected: string | null) =>
  [
    "## Available skills",
    [
      "Owner-written skills are listed below as JSON.",
      "Before multi-step work, check whether one matches the request;",
      "if so, call poppet_skills.view_skill and follow it.",
      skillAuthorityRule,
      ...(selected === null
        ? []
        : [`The skill ${JSON.stringify(selected)} is already selected and supplied above.`]),
      "A truncated index omits descriptions or skills; view a skill by name to read it.",
    ].join(" "),
  ].join("\n");
