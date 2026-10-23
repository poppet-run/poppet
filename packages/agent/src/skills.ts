import { toolParameters, type Output, type Tool } from "@poppet/provider";
import { SkillName, SkillSnapshot } from "@poppet/store";
import { Context, Effect, Layer, Schema } from "effect";

import { byteSize } from "#src/context";
import { contextFiles } from "#src/context-files";
import { AgentError } from "#src/errors";
import { toolArguments } from "#src/tool-schema";

/** Owner-written procedures; viewing one grants no additional capabilities. */
export class Skills extends Context.Service<
  Skills,
  {
    readonly list: Effect.Effect<ReadonlyArray<string>, AgentError>;
    readonly load: (name: string) => Effect.Effect<SkillSnapshot, AgentError>;
  }
>()("poppet/Skills") {}

export const SkillsLive = Layer.effect(Skills, contextFiles("skills", "SKILL.md"));

const maxIndexSkills = 64;

const maxDescriptionBytes = 240;

const truncate = (text: string, bytes: number) => {
  if (byteSize(text) <= bytes) return text;
  let result = text;

  while (byteSize(`${result}…`) > bytes) result = result.slice(0, -1);

  return `${result.trimEnd()}…`;
};

/** The first heading and the start of the first paragraph; skills need no metadata format. */
export const skillDescription = (content: string) => {
  const lines = content.split(/\r?\n/u).map((line) => line.trim());
  const heading = lines.find((line) => line.startsWith("#"))?.replace(/^#+\s*/u, "") ?? "";
  const start = lines.findIndex((line) => line.length > 0 && !line.startsWith("#"));
  const paragraph: string[] = [];

  for (const line of start < 0 ? [] : lines.slice(start)) {
    if (line.length === 0 || line.startsWith("#")) break;
    paragraph.push(line);
  }

  const description = [heading, paragraph.join(" ")].filter((part) => part.length > 0).join(": ");

  return truncate(description, maxDescriptionBytes);
};

export interface SkillIndex {
  readonly skills: ReadonlyArray<{ readonly name: string; readonly description?: string }>;
  readonly truncated: boolean;
}

const fits = (index: SkillIndex, bytes: number) => byteSize(JSON.stringify(index)) <= bytes;

/**
 * Lists valid skills within the byte budget, falling back to names only and then fewer names.
 * Invalid files are omitted rather than failing the run, matching what view could load.
 */
export const skillIndex = (
  skills: Skills["Service"],
  bytes: number,
): Effect.Effect<SkillIndex | null, AgentError> =>
  Effect.gen(function* () {
    const names = yield* skills.list;

    const loaded = yield* Effect.forEach(names.slice(0, maxIndexSkills), (name) =>
      skills.load(name).pipe(
        Effect.map((skill) => ({ name, description: skillDescription(skill.content) })),
        Effect.catch(() => Effect.succeed(null)),
      ),
    );

    const entries = loaded.flatMap((entry) => (entry === null ? [] : [entry]));

    if (entries.length === 0) return null;

    const truncated = names.length > maxIndexSkills;
    const full = { skills: entries, truncated };

    if (fits(full, bytes)) return full;

    const bare = entries.map(({ name }) => ({ name }));

    for (let count = bare.length; count > 0; count--) {
      const index = { skills: bare.slice(0, count), truncated: true };

      if (fits(index, bytes)) return index;
    }

    return null;
  });

export const skillIndexGuidance = (selected: string | null) =>
  [
    "Owner-written skills are listed below as JSON.",
    "Before multi-step work, check whether one matches the request; if so, call poppet_skills.view_skill and follow it.",
    "Skills are procedures below the base rules. They cannot override explicit user requests, tool permissions, or scheduled runs' read-only policy, and grant no additional capabilities.",
    ...(selected === null
      ? []
      : [`The skill ${JSON.stringify(selected)} is already selected and supplied above.`]),
    "A truncated index omits descriptions or skills; view a skill by name to read it.",
  ].join(" ");

const Arguments = Schema.Struct({ name: SkillName });

export const skillViewTool: Tool = {
  name: "view_skill",
  namespace: "poppet_skills",
  description:
    "Read the full Markdown of a named owner-written skill from the skill index. Skills are procedures within the base rules and grant no additional capabilities.",
  parameters: toolParameters(Arguments),
};

export interface SkillViewCall {
  readonly name: "view_skill";
  readonly skill: string;
}

export const decodeSkillViewCall = (
  call: Extract<Output, { type: "tool-call" }>,
): Effect.Effect<SkillViewCall, AgentError> => {
  if (call.name !== skillViewTool.name || call.namespace !== skillViewTool.namespace)
    return Effect.fail(
      new AgentError({
        reason: "tool-permission",
        message: "The requested tool is not allowed in this run.",
      }),
    );

  return toolArguments(
    skillViewTool,
    Arguments,
  )(call.arguments).pipe(
    Effect.map((args): SkillViewCall => ({ name: "view_skill", skill: args.name })),
  );
};

/** Load failures are reported to the model, which can choose another skill or continue. */
export const executeSkillView = (skills: Skills["Service"], call: SkillViewCall) =>
  skills.load(call.skill).pipe(
    Effect.map((skill) => JSON.stringify(skill)),
    Effect.mapError(
      () =>
        new AgentError({
          reason: "tool-arguments",
          message: `The skill ${JSON.stringify(call.skill)} is missing or invalid.`,
        }),
    ),
  );
