import { MemoryKey, MemoryValue, Store, StoreError } from "@poppet/store";
import { Console, Effect, Schema } from "effect";

export type MemoryCommand =
  | { readonly action: "list" }
  | { readonly action: "remember" | "replace"; readonly key: string; readonly value: string }
  | { readonly action: "forget"; readonly key: string };

const invalidArguments = (message: string) =>
  new StoreError({ reason: "invalid-request", message });

export const parseMemoryCommand = (
  args: ReadonlyArray<string>,
): Effect.Effect<MemoryCommand, StoreError> =>
  Effect.gen(function* () {
    const action = args[0];

    if (action === "list" && args.length === 1) return { action };

    if (
      (action !== "remember" && action !== "replace" && action !== "forget") ||
      (action === "forget" && args.length !== 2)
    )
      return yield* Effect.fail(
        invalidArguments(
          "Use memory list, remember <key> <value>, replace <key> <value>, or forget <key>.",
        ),
      );

    const key = yield* Schema.decodeUnknownEffect(MemoryKey)(args[1]).pipe(
      Effect.mapError(() =>
        invalidArguments(
          "Memory keys must start with a letter or digit and contain only letters, digits, dots, underscores, or hyphens, up to 128 characters.",
        ),
      ),
    );

    if (action === "forget") return { action, key };

    const value = yield* Schema.decodeUnknownEffect(MemoryValue)(args.slice(2).join(" ")).pipe(
      Effect.mapError(() =>
        invalidArguments(
          "Memory values must be nonempty, have no surrounding whitespace, and fit in 4096 UTF-8 bytes.",
        ),
      ),
    );

    return { action, key, value };
  });

export const manageMemory = (command: MemoryCommand) =>
  Effect.gen(function* () {
    const store = yield* Store;

    if (command.action === "list")
      return yield* Console.log(JSON.stringify(yield* store.memories, null, 2));

    if (command.action === "forget") {
      yield* store.forgetMemory(command.key);

      return yield* Console.log(`Forgot ${command.key}.`);
    }

    const operation =
      command.action === "remember"
        ? store.rememberMemory(command.key, command.value)
        : store.replaceMemory(command.key, command.value);

    const fact = yield* operation;

    yield* Console.log(JSON.stringify(fact, null, 2));
  });
