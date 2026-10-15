import { Memory, MemoryKey, MemoryValue } from "@poppet/memory";
import { Effect, Schema } from "effect";

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

    const operation =
      command.action === "remember"
        ? memory.remember(command.key, command.value)
        : memory.replace(command.key, command.value);

    const fact = yield* operation;

    return JSON.stringify(fact, null, 2);
  });
