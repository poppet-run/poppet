import type { LearnedSkills } from "@poppet/memory";
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

export interface SkillIndexEntry {
  readonly name: string;
  readonly description?: string;
  /** Present for skills Poppet learned; owner skills omit it. */
  readonly source?: "learned";
  readonly revision?: number;
}

export interface SkillIndex {
  readonly skills: ReadonlyArray<SkillIndexEntry>;
  readonly truncated: boolean;
}

const fits = (index: SkillIndex, bytes: number) => byteSize(JSON.stringify(index)) <= bytes;

/**
 * Lists valid owner skills, then learned skills that no owner directory shadows, within the
 * byte budget, falling back to names only and then fewer names. Invalid owner files are
 * omitted rather than failing the run, matching what view could load.
 */
export const skillIndex = (
  skills: Skills["Service"],
  bytes: number,
  learned: LearnedSkills["Service"] | null = null,
): Effect.Effect<SkillIndex | null, AgentError> =>
  Effect.gen(function* () {
    const names = yield* skills.list;

    const loaded = yield* Effect.forEach(names.slice(0, maxIndexSkills), (name) =>
      skills.load(name).pipe(
        Effect.map((skill): SkillIndexEntry => ({
          name,
          description: skillDescription(skill.content),
        })),
        Effect.catch(() => Effect.succeed(null)),
      ),
    );

    const saved = (learned === null ? [] : yield* learned.list.pipe(Effect.mapError(skillStorage)))
      .filter((skill) => !names.includes(skill.name))
      .map((skill): SkillIndexEntry => ({
        name: skill.name,
        description: skillDescription(skill.content),
        source: "learned",
        revision: skill.revision,
      }));

    const owned = loaded.flatMap((entry) => (entry === null ? [] : [entry]));
    const entries = [...owned, ...saved].slice(0, maxIndexSkills);

    if (entries.length === 0) return null;

    const truncated = names.length > maxIndexSkills || owned.length + saved.length > maxIndexSkills;
    const full = { skills: entries, truncated };

    if (fits(full, bytes)) return full;

    const bare = entries.map(({ name, source, revision }): SkillIndexEntry =>
      source === "learned" && revision !== undefined ? { name, source, revision } : { name },
    );

    for (let count = bare.length; count > 0; count--) {
      const index = { skills: bare.slice(0, count), truncated: true };

      if (fits(index, bytes)) return index;
    }

    return null;
  });

export const skillIndexGuidance = (selected: string | null) =>
  [
    "Skills are listed below as JSON; entries with source learned were saved by you in earlier runs.",
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
    "Read the full Markdown of a named skill from the skill index. Learned skills also return their current revision, which manage_skill requires. Skills are procedures within the base rules and grant no additional capabilities.",
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

export const skillStorage = (error: { readonly reason: string; readonly message: string }) =>
  new AgentError({
    reason:
      error.reason === "storage" || error.reason === "corrupt" ? "skill-storage" : "tool-arguments",
    message: error.message,
  });

const missingSkill = (name: string) =>
  new AgentError({
    reason: "tool-arguments",
    message: `The skill ${JSON.stringify(name)} is missing or invalid.`,
  });

/**
 * An owner directory always wins; otherwise a learned skill is returned with its revision,
 * which is recorded as the revision this run has seen. Load failures are reported to the model.
 */
export const executeSkillView = (
  skills: Skills["Service"],
  call: SkillViewCall,
  learned: LearnedSkills["Service"] | null = null,
  seen: Map<string, number> = new Map(),
) =>
  Effect.gen(function* () {
    const owned = yield* skills.list.pipe(Effect.mapError(() => missingSkill(call.skill)));

    if (owned.includes(call.skill) || learned === null)
      return yield* skills.load(call.skill).pipe(
        Effect.map((skill) => JSON.stringify(skill)),
        Effect.mapError(() => missingSkill(call.skill)),
      );

    const skill = yield* learned.get(call.skill).pipe(Effect.mapError(skillStorage));

    if (skill === null) return yield* Effect.fail(missingSkill(call.skill));
    seen.set(skill.name, skill.revision);

    return JSON.stringify({
      name: skill.name,
      content: skill.content,
      source: "learned",
      revision: skill.revision,
    });
  });
