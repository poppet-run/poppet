import { Skills, isManualOnly } from "@poppet/agent";
import { SkillName } from "@poppet/store";
import { Console, Effect } from "effect";
import { Argument, Command } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { jsonFlag } from "#src/commands/flags";
import { printResult, printWith } from "#src/output";

export const skillsCommand = (context: CLIContext) => {
  const { runtime } = context;

  return Command.make("skills").pipe(
    Command.withDescription("Inspect local Markdown skills"),
    Command.withSubcommands([
      Command.make("list", { json: jsonFlag }, ({ json }) =>
        Effect.gen(function* () {
          const skills = yield* Skills;
          const names = yield* skills.list;

          if (json || names.length === 0)
            return yield* printResult(json, names, () => "No local skills.");

          const lines = yield* Effect.forEach(names, (name) =>
            skills.load(name).pipe(
              Effect.map((skill) => (isManualOnly(skill.content) ? `${name}  manual-only` : name)),
              Effect.catch(() => Effect.succeed(name)),
            ),
          );

          return yield* Console.log(lines.join("\n"));
        }).pipe(Effect.provide(runtime.skills)),
      ).pipe(Command.withDescription("List local skills")),
      Command.make(
        "show",
        { name: Argument.String("name").pipe(Argument.withSchema(SkillName)), json: jsonFlag },
        ({ name, json }) =>
          Skills.use((skills) => skills.load(name)).pipe(
            Effect.map((skill) => ({ ...skill, manualOnly: isManualOnly(skill.content) })),
            printWith(json, (skill) => skill.content),
            Effect.provide(runtime.skills),
          ),
      ).pipe(Command.withDescription("Show a skill's Markdown instructions")),
    ]),
  );
};
