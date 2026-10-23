import { Skills } from "@poppet/agent";
import { SkillName } from "@poppet/store";
import { Console, Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { manageSkills, type SkillsCommand } from "#src/skills";

export const skillsCommand = (context: CLIContext) => {
  const { runtime, throughWorker } = context;
  const nameArgument = Argument.String("name").pipe(Argument.withSchema(SkillName));

  const runSkills = (command: SkillsCommand) =>
    throughWorker(
      { kind: "skills", command },
      manageSkills(command).pipe(
        Effect.provide(runtime.learnedSkills),
        Effect.provide(runtime.skills),
        Effect.provide(runtime.config),
        Effect.flatMap(Console.log),
      ),
    );

  const learnedAction = (action: "history" | "delete" | "promote", description: string) =>
    Command.make(action, { name: nameArgument }, ({ name }) => runSkills({ action, name })).pipe(
      Command.withDescription(description),
    );

  return Command.make("skills").pipe(
    Command.withDescription("Inspect local Markdown skills and skills Poppet learned"),
    Command.withSubcommands([
      Command.make("list", {}, () => runSkills({ action: "list" })).pipe(
        Command.withDescription("List local skills"),
      ),
      Command.make("show", { name: nameArgument }, ({ name }) =>
        // Owner files need no database; only learned skills are read from storage.
        Skills.use((skills) => skills.list).pipe(
          Effect.provide(runtime.skills),
          Effect.flatMap((owned) =>
            owned.includes(name)
              ? Skills.use((skills) => skills.load(name)).pipe(
                  Effect.flatMap((skill) => Console.log(skill.content)),
                  Effect.provide(runtime.skills),
                )
              : runSkills({ action: "show", name }),
          ),
        ),
      ).pipe(Command.withDescription("Show a skill's Markdown instructions")),
      learnedAction("history", "Show a learned skill's revisions"),
      Command.make(
        "revert",
        {
          name: nameArgument,
          revision: Argument.Int("revision").pipe(
            Argument.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
          ),
        },
        ({ name, revision }) => runSkills({ action: "revert", name, revision }),
      ).pipe(Command.withDescription("Restore a learned skill revision as a new revision")),
      learnedAction("delete", "Delete a learned skill, keeping its history"),
      learnedAction("promote", "Copy a learned skill to a new owner skill file"),
    ]),
  );
};
