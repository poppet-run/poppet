import { MemoryFact, MemoryKey, MemoryRevision, MemoryValue } from "@poppet/memory";
import { Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { jsonFlag, textArgument } from "#src/commands/flags";
import { manageMemory, type MemoryCommand } from "#src/commands/memory/memory";
import { fields, printParsed, table, tableOr, time } from "#src/output";

const Forgotten = Schema.Struct({ key: Schema.String, forgotten: Schema.Literal(true) });

const factFields = (fact: MemoryFact) =>
  fields([
    ["Key", fact.key],
    ["Value", fact.value],
    ["Origin", fact.origin],
    ["Updated", time(fact.updatedAt)],
  ]);

const forgotten = (result: typeof Forgotten.Type) => `Forgot ${result.key}.`;

/** Prints a memory result; local results and worker replies share each action's shape. */
const printMemory = <A>(json: boolean, command: MemoryCommand, value: A) => {
  switch (command.action) {
    case "list":
      return printParsed(json, value, Schema.Array(MemoryFact), (facts) =>
        tableOr(
          "No saved facts. Save one with poppet memory set.",
          ["KEY", "ORIGIN", "UPDATED", "VALUE"],
          facts.map((fact) => [fact.key, fact.origin, time(fact.updatedAt), fact.value]),
        ),
      );
    case "history":
      return printParsed(json, value, Schema.Array(MemoryRevision), (revisions) =>
        table(
          ["REVISION", "ACTION", "ORIGIN", "CREATED", "VALUE"],
          revisions.map((revision) => [
            String(revision.revision),
            revision.action,
            revision.origin,
            time(revision.createdAt),
            revision.value ?? "-",
          ]),
        ),
      );
    case "set":
      return printParsed(
        json,
        value,
        MemoryFact,
        (fact) => `Saved ${fact.key}.\n\n${factFields(fact)}`,
      );
    case "forget":
      return printParsed(json, value, Forgotten, forgotten);
    case "revert":
      // Reverting to a forget revision leaves no fact.
      return printParsed(json, value, Schema.Union([Forgotten, MemoryFact]), (result) =>
        Schema.is(Forgotten)(result)
          ? forgotten(result)
          : `Restored revision ${command.revision} of ${result.key}.\n\n${factFields(result)}`,
      );
  }
};

export const memoryCommand = (context: CLIContext) => {
  const { runtime, queryWorker } = context;

  const runMemory = (command: MemoryCommand, json: boolean) =>
    queryWorker(
      { kind: "memory", command },
      manageMemory(command).pipe(Effect.provide(runtime.memory)),
    ).pipe(Effect.flatMap((result) => printMemory(json, command, result)));

  const keyArgument = Argument.String("key").pipe(Argument.withSchema(MemoryKey));

  return Command.make("memory").pipe(
    Command.withDescription("Manage explicitly saved facts"),
    Command.withSubcommands([
      Command.make("list", { json: jsonFlag }, ({ json }) =>
        runMemory({ action: "list" }, json),
      ).pipe(Command.withDescription("List saved facts")),
      Command.make(
        "set",
        {
          key: keyArgument,
          json: jsonFlag,
          value: textArgument("value").pipe(Argument.withSchema(MemoryValue)),
        },
        ({ key, value, json }) => runMemory({ action: "set", key, value }, json),
      ).pipe(Command.withDescription("Save a fact, replacing any current value")),
      Command.make("forget", { key: keyArgument, json: jsonFlag }, ({ key, json }) =>
        runMemory({ action: "forget", key }, json),
      ).pipe(Command.withDescription("Delete a fact")),
      Command.make("history", { key: keyArgument, json: jsonFlag }, ({ key, json }) =>
        runMemory({ action: "history", key }, json),
      ).pipe(Command.withDescription("Show a fact's revisions and their sources")),
      Command.make(
        "revert",
        {
          key: keyArgument,
          revision: Argument.Int("revision").pipe(
            Argument.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
          ),
          json: jsonFlag,
        },
        ({ key, revision, json }) => runMemory({ action: "revert", key, revision }, json),
      ).pipe(Command.withDescription("Restore an earlier fact revision as a new revision")),
    ]),
  );
};
