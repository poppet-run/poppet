import { SkillName } from "@poppet/store";
import { Argument, Flag } from "effect/cli";

export const textArgument = (name: string) =>
  Argument.String(name).pipe(
    Argument.variadic({ min: 1 }),
    Argument.map((words) => words.join(" ")),
  );

/** An optional boolean flag that is false when omitted. */
export const booleanFlag = (name: string, description: string) =>
  Flag.Boolean(name).pipe(
    Flag.withDescription(description),
    Flag.atMost(1),
    Flag.map(([value = false]) => value),
  );

export const codingFlag = booleanFlag("coding", "Use the coding workload");

export const skillFlag = Flag.String("skill").pipe(
  Flag.withSchema(SkillName),
  Flag.withDescription("Select a local Markdown skill and save its current text"),
  Flag.atMost(1),
  Flag.map(([value]) => value),
);
