import { Projects } from "@poppet/agent";
import { Memory, MemoryError, MemoryKey, MemoryValue } from "@poppet/memory";
import { ProjectName } from "@poppet/store";
import { Effect, Option, Schema } from "effect";

/** Explicit fact-management requests shared by direct CLI execution and worker routing. */
export const MemoryCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list"), project: Schema.optionalKey(ProjectName) }),
  Schema.Struct({
    action: Schema.Literals(["remember", "replace"]),
    project: Schema.optionalKey(ProjectName),
    key: MemoryKey,
    value: MemoryValue,
  }),
  Schema.Struct({
    action: Schema.Literal("forget"),
    key: MemoryKey,
    project: Schema.optionalKey(ProjectName),
  }),
  Schema.Struct({
    action: Schema.Literal("history"),
    key: MemoryKey,
    project: Schema.optionalKey(ProjectName),
  }),
  Schema.Struct({
    action: Schema.Literal("revert"),
    key: MemoryKey,
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    project: Schema.optionalKey(ProjectName),
  }),
]);

export type MemoryCommand = typeof MemoryCommand.Type;

export const manageMemory = (command: MemoryCommand) =>
  Effect.gen(function* () {
    const global = yield* Memory;
    const memory = command.project === undefined ? global : global.forProject?.(command.project);

    if (memory === undefined)
      return yield* Effect.fail(
        new MemoryError({
          reason: "invalid-request",
          message: "Project memory is unavailable. Restart the worker.",
        }),
      );

    if (command.action === "list") {
      const facts = yield* memory.list;

      if (command.project === undefined) return JSON.stringify(facts, null, 2);
      const projects = yield* Effect.serviceOption(Projects);

      const orphaned = Option.isSome(projects)
        ? !(yield* projects.value.list).includes(command.project)
        : null;

      return JSON.stringify({ project: command.project, orphaned, facts }, null, 2);
    }

    if (command.action === "history" || command.action === "revert") {
      if (memory.history === undefined || memory.revert === undefined)
        return yield* Effect.fail(
          new MemoryError({
            reason: "invalid-request",
            message: "Memory history is unavailable. Restart the worker.",
          }),
        );

      if (command.action === "history") {
        const history = yield* memory.history(command.key);

        if (history.length === 0)
          return yield* Effect.fail(
            new MemoryError({ reason: "not-found", message: "The fact has no saved history." }),
          );

        return JSON.stringify(history, null, 2);
      }

      const fact = yield* memory.revert(command.key, command.revision);

      return fact === null ? `Forgot ${command.key}.` : JSON.stringify(fact, null, 2);
    }

    if (command.action === "forget") {
      yield* memory.forget(command.key);

      return `Forgot ${command.key}.`;
    }

    const fact = yield* memory[command.action](command.key, command.value);

    return JSON.stringify(
      command.project === undefined ? fact : { project: command.project, ...fact },
      null,
      2,
    );
  });
