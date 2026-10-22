import { Projects } from "@poppet/agent";
import { ProjectName } from "@poppet/store";
import { Console, Effect } from "effect";
import { Argument, Command } from "effect/cli";

import type { CLIContext } from "#src/commands/context";

export const projectsCommand = (context: CLIContext) => {
  const { runtime } = context;

  return Command.make("projects").pipe(
    Command.withDescription("Inspect local project context snapshots"),
    Command.withSubcommands([
      Command.make("list", {}, () =>
        Projects.use((projects) => projects.list).pipe(
          Effect.flatMap((names) => Console.log(JSON.stringify(names, null, 2))),
          Effect.provide(runtime.skills),
        ),
      ),
      Command.make(
        "show",
        { name: Argument.String("name").pipe(Argument.withSchema(ProjectName)) },
        ({ name }) =>
          Projects.use((projects) => projects.load(name)).pipe(
            Effect.flatMap((project) => Console.log(JSON.stringify(project, null, 2))),
            Effect.provide(runtime.skills),
          ),
      ),
    ]),
  );
};
