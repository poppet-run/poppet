import { MemoryKey, MemoryValue } from "@poppet/memory";
import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { projectFlag, textArgument } from "#src/commands/flags";
import { manageMemory, type MemoryCommand } from "#src/memory";

export const memoryCommand = (context: CLIContext) => {
  const { runtime, throughWorker } = context;

  const memoryProjectFlag = projectFlag.pipe(
    Flag.withDescription("Use this project's saved facts instead of global facts"),
  );

  const runMemory = (command: MemoryCommand) =>
    throughWorker(
      { kind: "memory", command },
      manageMemory(command).pipe(
        Effect.provide(runtime.memory),
        Effect.provide(runtime.skills),
        Effect.flatMap(Console.log),
      ),
    );

  return Command.make("memory").pipe(
    Command.withDescription("Manage explicitly saved facts"),
    Command.withSubcommands([
      Command.make("list", { project: memoryProjectFlag }, ({ project }) =>
        runMemory(project === undefined ? { action: "list" } : { action: "list", project }),
      ).pipe(Command.withDescription("List saved facts")),
      ...(["remember", "replace"] as const).map((action) =>
        Command.make(
          action,
          {
            project: memoryProjectFlag,
            key: Argument.String("key").pipe(Argument.withSchema(MemoryKey)),
            value: textArgument("value").pipe(Argument.withSchema(MemoryValue)),
          },
          ({ key, value, project }) =>
            runMemory(
              project === undefined ? { action, key, value } : { action, key, value, project },
            ),
        ).pipe(
          Command.withDescription(
            action === "remember" ? "Save a new fact" : "Change an existing fact",
          ),
        ),
      ),
      Command.make(
        "forget",
        {
          key: Argument.String("key").pipe(Argument.withSchema(MemoryKey)),
          project: memoryProjectFlag,
        },
        ({ key, project }) =>
          runMemory(
            project === undefined ? { action: "forget", key } : { action: "forget", key, project },
          ),
      ).pipe(Command.withDescription("Delete a fact")),
    ]),
  );
};
