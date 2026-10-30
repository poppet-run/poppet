import { Skills } from "@poppet/agent";
import { SkillName } from "@poppet/store";
import { Effect } from "effect";
import { Argument, Command } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { jsonFlag } from "#src/commands/flags";
import { printWith } from "#src/output";

export const skillsCommand = (context: CLIContext) => {
  const { runtime } = context;

  return Command.make("skills").pipe(
    Command.withDescription("Inspect local Markdown skills"),
    Command.withSubcommands([
      Command.make("list", { json: jsonFlag }, ({ json }) =>
        Skills.use((skills) => skills.list).pipe(
          printWith(json, (names) => (names.length === 0 ? "No local skills." : names.join("\n"))),
          Effect.provide(runtime.skills),
        ),
      ).pipe(Command.withDescription("List local skills")),
      Command.make(
        "show",
        { name: Argument.String("name").pipe(Argument.withSchema(SkillName)), json: jsonFlag },
        ({ name, json }) =>
          Skills.use((skills) => skills.load(name)).pipe(
            printWith(json, (skill) => skill.content),
            Effect.provide(runtime.skills),
          ),
      ).pipe(Command.withDescription("Show a skill's Markdown instructions")),
    ]),
  );
};
