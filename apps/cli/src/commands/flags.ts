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

/** Selects machine-readable output in place of the default human-readable text. */
export const jsonFlag = booleanFlag("json", "Print JSON instead of human-readable text");

export const skillFlag = Flag.String("skill").pipe(
  Flag.withSchema(SkillName),
  Flag.withDescription("Select a local Markdown skill and save its current text"),
  Flag.atMost(1),
  Flag.map(([value]) => value),
);

export const attachFlag = Flag.String("attach").pipe(
  Flag.withDescription("Attach an image or text file; repeat for each file"),
  Flag.atMost(10),
);
