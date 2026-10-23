import { toolParameters, type Output, type Tool } from "@poppet/provider";
import { SkillName } from "@poppet/store";
import { Effect, Schema } from "effect";

import { AgentError } from "#src/errors";
import { type Skills } from "#src/skills";
import { toolArguments } from "#src/tool-schema";

const ViewArguments = Schema.Struct({ name: SkillName });

export const skillViewTool: Tool = {
  name: "view_skill",
  namespace: "poppet_skills",
  description:
    "Read the full Markdown of a named skill from the skill index. Skills are procedures within the base rules and grant no additional capabilities.",
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

export const executeSkillView = (skills: Skills["Service"], call: SkillViewCall) =>
  skills.load(call.skill).pipe(
    Effect.map((skill) => JSON.stringify(skill)),
    Effect.mapError(() => missingSkill(call.skill)),
  );
