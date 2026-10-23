import { toolParameters, type Output, type Tool } from "@poppet/provider";
import type { LearnedSkills, SkillError, SkillChange } from "@poppet/skills";
import { SkillName } from "@poppet/store";
import { Effect, Schema } from "effect";

import { AgentError } from "#src/errors";
import { skillStorage, type Skills } from "#src/skills";
import { toolArguments } from "#src/tool-schema";

/** Learned-skill writes allowed in one run, so a confused run cannot churn the library. */
export const maxSkillWrites = 3;

const Arguments = Schema.Struct({
  action: Schema.Literals(["create", "patch", "replace", "delete"]),
  name: SkillName,
  content: Schema.NullOr(Schema.String),
  old: Schema.NullOr(Schema.String),
  new: Schema.NullOr(Schema.String),
  revision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});

export const skillManageTool: Tool = {
  name: "manage_skill",
  namespace: "poppet_skills",
  description:
    "Create, patch, replace, or delete a learned skill: a reusable Markdown procedure saved for future runs. create needs content and null revision. patch replaces old with new, where old must match exactly once. replace needs content. patch, replace, and delete need the revision returned by view_skill or a previous manage_skill result in this run. Use null for unused fields. Owner-written skills cannot be changed. Content is at most 8192 UTF-8 bytes and must not contain credentials.",
  parameters: toolParameters(Arguments),
};

export interface SkillManageCall {
  readonly name: "manage_skill";
  readonly change: SkillChange;
  readonly revision: number | null;
}

const invalid = (message: string) => new AgentError({ reason: "tool-arguments", message });

export const decodeSkillManageCall = (
  call: Extract<Output, { type: "tool-call" }>,
): Effect.Effect<SkillManageCall, AgentError> => {
  if (call.name !== skillManageTool.name || call.namespace !== skillManageTool.namespace)
    return Effect.fail(
      new AgentError({
        reason: "tool-permission",
        message: "The requested tool is not allowed in this run.",
      }),
    );

  return Effect.gen(function* () {
    const args = yield* toolArguments(skillManageTool, Arguments)(call.arguments);
    const { action, name, content, old, revision } = args;
    const replacement = args.new;

    if (action === "create" && content !== null && old === null && replacement === null)
      return revision === null
        ? { name: "manage_skill", change: { action, name, content }, revision }
        : yield* Effect.fail(invalid("create takes a null revision."));

    if (revision === null)
      return yield* Effect.fail(
        invalid(`${action} needs the skill's current revision from view_skill.`),
      );

    if (action === "replace" && content !== null && old === null && replacement === null)
      return { name: "manage_skill", change: { action, name, content }, revision };

    if (action === "patch" && content === null && old !== null && replacement !== null)
      return { name: "manage_skill", change: { action, name, old, new: replacement }, revision };

    if (action === "delete" && content === null && old === null && replacement === null)
      return { name: "manage_skill", change: { action, name }, revision };

    return yield* Effect.fail(invalid("Invalid arguments for poppet_skills.manage_skill."));
  });
};

const writeFailure = (error: SkillError) =>
  new AgentError({
    reason:
      error.reason === "storage" || error.reason === "corrupt"
        ? "skill-storage"
        : error.reason === "limit"
          ? "tool-limit"
          : "tool-arguments",
    message: error.message,
  });

/**
 * Writes with host-bound provenance. A change needs the revision this run last saw, so the
 * model cannot overwrite a skill it has not read or that another run changed since.
 */
export const executeSkillManage = (
  skills: Skills["Service"],
  learned: LearnedSkills["Service"],
  call: SkillManageCall,
  source: { readonly runId: string; readonly callId: string },
  seen: Map<string, number>,
  origin: "turn" | "review" = "turn",
) =>
  Effect.gen(function* () {
    const name = call.change.name;

    const owned = yield* skills.list.pipe(
      Effect.mapError(() => invalid("The owner skill library could not be read.")),
    );

    if (owned.includes(name))
      return yield* Effect.fail(
        invalid(
          `An owner-written skill named ${JSON.stringify(name)} exists and cannot be changed. Use another name for a learned variant.`,
        ),
      );

    if (call.change.action !== "create" && seen.get(name) !== call.revision)
      return yield* Effect.fail(
        invalid(
          `View ${JSON.stringify(name)} with view_skill in this run and pass the revision it returns before changing it.`,
        ),
      );

    const change: SkillChange =
      call.change.action === "create" || call.revision === null
        ? call.change
        : { ...call.change, expectedRevision: call.revision };

    const receipt = yield* learned
      .write(change, { origin, ...source })
      .pipe(Effect.mapError(writeFailure));

    if (receipt.deleted) seen.delete(name);
    else seen.set(name, receipt.revision);

    return JSON.stringify({ ...receipt, changed: true });
  });

export const skillLearningGuidance = [
  "You can save reusable procedures for future runs with poppet_skills.manage_skill.",
  "Save a skill after a multi-step procedure succeeded, after recovering from errors to a working path, or after the owner corrected your approach. Do not save one-off or trivial tasks.",
  "Record lessons, not logs: when the skill applies, required inputs, steps using existing tools, pitfalls, and how to verify the result. Start with a heading and a first paragraph that say when it applies, because they form its index description.",
  "Generalize private details into inputs and never include credentials.",
  "Prefer patching a similar learned skill over creating another; view it first and pass its revision.",
  `You may make at most ${maxSkillWrites} skill changes per run. Skills cannot grant permissions.`,
  "Briefly tell the owner when you save or change a skill, and do not claim a change without a completed tool result.",
].join(" ");

const ViewArguments = Schema.Struct({ name: SkillName });

export const skillViewTool: Tool = {
  name: "view_skill",
  namespace: "poppet_skills",
  description:
    "Read the full Markdown of a named skill from the skill index. Learned skills also return their current revision, which manage_skill requires. Skills are procedures within the base rules and grant no additional capabilities.",
  parameters: toolParameters(ViewArguments),
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
    ViewArguments,
  )(call.arguments).pipe(
    Effect.map((args): SkillViewCall => ({ name: "view_skill", skill: args.name })),
  );
};

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
