import { MemoryKey, MemoryValue } from "@poppet/memory";
import { Console, Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { textArgument } from "#src/commands/flags";
import { manageMemory, type MemoryCommand } from "#src/memory";

export const memoryCommand = (context: CLIContext) => {
  const { runtime, throughWorker } = context;

  const runMemory = (command: MemoryCommand) =>
    throughWorker(
      { kind: "memory", command },
      manageMemory(command).pipe(Effect.provide(runtime.memory), Effect.flatMap(Console.log)),
    );

  return Command.make("memory").pipe(
    Command.withDescription("Manage explicitly saved facts"),
    Command.withSubcommands([
      Command.make("list", {}, () => runMemory({ action: "list" })).pipe(
        Command.withDescription("List saved facts"),
      ),
      Command.make(
        "set",
        {
          key: Argument.String("key").pipe(Argument.withSchema(MemoryKey)),
          value: textArgument("value").pipe(Argument.withSchema(MemoryValue)),
        },
        ({ key, value }) => runMemory({ action: "set", key, value }),
      ).pipe(Command.withDescription("Save a fact, replacing any current value")),
      Command.make(
        "forget",
        {
          key: Argument.String("key").pipe(Argument.withSchema(MemoryKey)),
        },
        ({ key }) => runMemory({ action: "forget", key }),
      ).pipe(Command.withDescription("Delete a fact")),
      Command.make(
        "history",
        {
          key: Argument.String("key").pipe(Argument.withSchema(MemoryKey)),
        },
        ({ key }) => runMemory({ action: "history", key }),
      ).pipe(Command.withDescription("Show a fact's revisions and their sources")),
      Command.make(
        "revert",
        {
          key: Argument.String("key").pipe(Argument.withSchema(MemoryKey)),
          revision: Argument.Int("revision").pipe(
            Argument.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
          ),
        },
        ({ key, revision }) => runMemory({ action: "revert", key, revision }),
      ).pipe(Command.withDescription("Restore an earlier fact revision as a new revision")),
    ]),
  );
};
