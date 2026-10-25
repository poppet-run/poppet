import { toolParameters, type Tool } from "@poppet/provider";
import { SkillName } from "@poppet/store";
import { Effect, Option, Schema } from "effect";

import { contextTool, type ToolCall } from "#src/agent-tool";
import { AgentError } from "#src/errors";
import { Skills } from "#src/skills";
import { toolArguments } from "#src/tool-schema";

const ViewArguments = Schema.Struct({ name: SkillName });

export const skillViewDefinition: Tool = {
  name: "view_skill",
  namespace: "poppet_skills",
  description:
    "Read the full Markdown of a named skill from the skill index. Skills are procedures within the base rules and grant no additional capabilities.",
  parameters: toolParameters(ViewArguments),
};

export const decodeSkillViewCall = (call: ToolCall): Effect.Effect<string, AgentError> =>
  toolArguments(
    skillViewDefinition,
    ViewArguments,
  )(call.arguments).pipe(Effect.map((args) => args.name));

const missingSkill = (name: string) =>
  new AgentError({
    reason: "tool-arguments",
    message: `The skill ${JSON.stringify(name)} is missing or invalid.`,
  });

export const executeSkillView = (skills: Skills["Service"], name: string) =>
  skills.load(name).pipe(
    Effect.map((skill) => JSON.stringify(skill)),
    Effect.mapError(() => missingSkill(name)),
  );

/** Loads a skill named in the run's index; absent when the host has no skills. */
export const skillViewTool = Effect.gen(function* () {
  const skills = Option.getOrNull(yield* Effect.serviceOption(Skills));

  if (skills === null) return null;

  return contextTool({
    definition: skillViewDefinition,
    prepare: (call) =>
      decodeSkillViewCall(call).pipe(
        Effect.map((name) => ({ execute: executeSkillView(skills, name) })),
      ),
    untrustedResult: false,
  });
});
