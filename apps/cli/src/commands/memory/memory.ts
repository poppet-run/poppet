import { Memory, MemoryError, MemoryKey, MemoryValue } from "@poppet/memory";
import { Effect, Schema } from "effect";

/** Explicit fact-management requests shared by direct CLI execution and worker routing. */
export const MemoryCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({
    action: Schema.Literal("set"),
    key: MemoryKey,
    value: MemoryValue,
  }),
  Schema.Struct({
    action: Schema.Literal("forget"),
    key: MemoryKey,
  }),
  Schema.Struct({
    action: Schema.Literal("history"),
    key: MemoryKey,
  }),
  Schema.Struct({
    action: Schema.Literal("revert"),
    key: MemoryKey,
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
]);

export type MemoryCommand = typeof MemoryCommand.Type;

/** Runs a fact command; forgetting reports the key, since no fact remains. */
export const manageMemory = (command: MemoryCommand) =>
  Effect.gen(function* () {
    const memory = yield* Memory;

    if (command.action === "list") return yield* memory.list;

    if (command.action === "history") {
      const history = yield* memory.history(command.key);

      if (history.length === 0)
        return yield* Effect.fail(
          new MemoryError({ reason: "not-found", message: "The fact has no saved history." }),
        );

      return history;
    }

    if (command.action === "revert")
      return (yield* memory.revert(command.key, command.revision)) ?? forgotten(command.key);

    if (command.action === "forget") {
      yield* memory.forget(command.key);

      return forgotten(command.key);
    }

    return yield* memory.set(command.key, command.value);
  });

const forgotten = (key: string) => ({ key, forgotten: true as const });
