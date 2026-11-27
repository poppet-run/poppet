import { Memory, MemoryKey, MemoryValue } from "@poppet/memory";
import { toolParameters } from "@poppet/provider";
import type { Tool } from "@poppet/provider";
import { Effect, Schema } from "effect";

import { byteSize } from "#src/context";
import { AgentError } from "#src/errors";
import { ChatSettings } from "#src/settings";
import { builtinFailures } from "#src/tools/agent-tool";
import type { AgentTool, FailurePolicy, ToolCall } from "#src/tools/agent-tool";
import { toolArguments } from "#src/tools/tool-schema";

const Arguments = Schema.Struct({
  action: Schema.Literals(["remember", "replace", "forget"]).annotate({
    description: "remember creates a new key; replace and forget require an existing key.",
  }),
  key: MemoryKey.annotate({ description: "Fact key." }),
  value: Schema.NullOr(MemoryValue).annotate({
    description: "Nonempty trimmed fact value (max 4096 UTF-8 bytes), or null for forget.",
  }),
});

export const memoryDefinition: Tool = {
  name: "memory",
  namespace: "poppet_memory",
  description: [
    "Remember, replace, or forget a saved fact only when the owner explicitly asks.",
    "Never infer or save facts automatically.",
    "Current facts are supplied in context.",
  ].join(" "),
  parameters: toolParameters(Arguments),
};

export type MemoryCall =
  | { readonly action: "remember" | "replace"; readonly key: string; readonly value: string }
  | { readonly action: "forget"; readonly key: string };

const invalid = () =>
  new AgentError({
    reason: "tool-arguments",
    message: "Invalid arguments for poppet_memory.memory.",
  });

export const decodeMemoryCall = (call: ToolCall): Effect.Effect<MemoryCall, AgentError> =>
  Effect.gen(function* () {
    const args = yield* toolArguments(memoryDefinition, Arguments)(call.arguments);

    if (args.action === "forget" && args.value === null) {
      return { action: "forget", key: args.key };
    }

    if (args.action !== "forget" && args.value !== null) {
      return { action: args.action, key: args.key, value: args.value };
    }

    return yield* Effect.fail(invalid());
  });

export const executeMemoryCall = (
  memory: Memory["Service"],
  call: MemoryCall,
  runId: string,
  factsBytes: number,
): Effect.Effect<string, AgentError> =>
  Effect.gen(function* () {
    if (call.action === "forget") {
      yield* memory.forget(call.key, runId);
    } else {
      const facts = (yield* memory.list).map(({ key, value }) => ({ key, value }));
      const next = facts.filter((fact) => fact.key !== call.key);
      next.push({ key: call.key, value: call.value });

      if (byteSize(JSON.stringify(next)) > factsBytes) {
        return yield* Effect.fail(
          new AgentError({
            reason: "memory-limit",
            message: `This change would exceed this run's ${factsBytes}-byte fact budget. Shorten or forget a fact before adding it.`,
          }),
        );
      }

      yield* memory[call.action](call.key, call.value, runId);
    }

    return JSON.stringify({ action: call.action, key: call.key, changed: true });
  }).pipe(
    Effect.mapError((error) =>
      error instanceof AgentError
        ? error
        : new AgentError({
            reason:
              error.reason === "storage" || error.reason === "corrupt"
                ? "memory-storage"
                : error.reason === "limit"
                  ? "memory-limit"
                  : "tool-arguments",
            message: error.message,
          }),
    ),
  );

export const memoryFailures: FailurePolicy = {
  ...builtinFailures,
  uncertain: new Set(["agent:memory-storage"]),
};

export const memoryTool = Effect.gen(function* () {
  const memory = yield* Memory;
  const { factsBytes } = yield* ChatSettings;

  return {
    definition: memoryDefinition,
    prepare: (call, { run }) =>
      decodeMemoryCall(call).pipe(
        Effect.map((change) => ({
          execute: executeMemoryCall(memory, change, run.id, factsBytes),
        })),
      ),
    untrustedResult: false,
    withdrawnWhenUntrusted: true,
    contextOnly: false,
    availableWhenScheduled: false,
    failures: memoryFailures,
    uninterruptible: true,
  } satisfies AgentTool;
});
