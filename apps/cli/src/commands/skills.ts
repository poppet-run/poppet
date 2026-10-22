import { Skills } from "@poppet/agent";
import { SkillName } from "@poppet/store";
import { Console, Effect } from "effect";
import { Argument, Command } from "effect/cli";

import type { CLIContext } from "#src/commands/context";

export const skillsCommand = (context: CLIContext) => {
  const { runtime } = context;

  return Command.make("skills").pipe(
    Command.withDescription("Inspect local Markdown skills"),
    Command.withSubcommands([
      Command.make("list", {}, () =>
        Skills.use((skills) => skills.list).pipe(
          Effect.flatMap((names) => Console.log(JSON.stringify(names, null, 2))),
          Effect.provide(runtime.skills),
        ),
      ),
      Command.make(
        "show",
        { name: Argument.String("name").pipe(Argument.withSchema(SkillName)) },
        ({ name }) =>
          Skills.use((skills) => skills.load(name)).pipe(
            Effect.flatMap((skill) => Console.log(skill.content)),
            Effect.provide(runtime.skills),
          ),
      ),
    ]),
  );
};
