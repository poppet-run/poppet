import { Memory, MemoryKey, MemoryValue } from "@poppet/memory";
import { Effect, Schema } from "effect";

/** Explicit fact-management requests shared by direct CLI execution and worker routing. */
export const MemoryCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({
    action: Schema.Literals(["remember", "replace"]),
    key: MemoryKey,
    value: MemoryValue,
  }),
  Schema.Struct({ action: Schema.Literal("forget"), key: MemoryKey }),
]);

export type MemoryCommand = typeof MemoryCommand.Type;

export const manageMemory = (command: MemoryCommand) =>
  Effect.gen(function* () {
    const memory = yield* Memory;

    if (command.action === "list") return JSON.stringify(yield* memory.list, null, 2);

    if (command.action === "forget") {
      yield* memory.forget(command.key);

      return `Forgot ${command.key}.`;
    }

    const fact = yield* memory[command.action](command.key, command.value);

    return JSON.stringify(fact, null, 2);
  });
