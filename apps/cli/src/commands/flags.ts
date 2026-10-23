import { SkillName } from "@poppet/store";
import { Argument, Flag } from "effect/cli";

export const textArgument = (name: string) =>
  Argument.String(name).pipe(
    Argument.variadic({ min: 1 }),
    Argument.map((words) => words.join(" ")),
  );

export const codingFlag = Flag.Boolean("coding").pipe(
  Flag.withDescription("Use the coding workload"),
  Flag.atMost(1),
  Flag.map(([value = false]) => value),
);

export const skillFlag = Flag.String("skill").pipe(
  Flag.withSchema(SkillName),
  Flag.withDescription("Select a local Markdown skill and save its current text"),
  Flag.atMost(1),
  Flag.map(([value]) => value),
);
