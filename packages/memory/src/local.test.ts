import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import type { Completion } from "@poppet/provider";
import { Store, StoreLive } from "@poppet/store";
import { Effect, Layer } from "effect";

import { LocalMemoryLive } from "#src/local";
import { Memory, MemoryError } from "#src/service";

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-local-memory-"));

  const config = Layer.succeed(AppConfig, {
    applicationName: "Test",
    dataDirectory: directory,
    notesDirectory: join(directory, "notes"),
    provider: "first-provider",
    model: null,
  });

  const store = StoreLive.pipe(Layer.provideMerge(config));
  const layer = LocalMemoryLive.pipe(Layer.provideMerge(store));

  return {
    directory,
    run: <A, E>(program: Effect.Effect<A, E, Memory | Store>) =>
      Effect.runPromise(program.pipe(Effect.provide(layer))),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

const response: Completion = {
  output: [{ type: "text", text: "Complete" }],
  continuation: { version: 1, provider: "first-provider", model: "selected-model", data: {} },
  finishReason: "stop",
  usage: null,
};

const reject = <A>(operation: Effect.Effect<A, MemoryError>, reason: MemoryError["reason"]) =>
  operation.pipe(
    Effect.match({
      onFailure: (error) => expect(error.reason).toBe(reason),
      onSuccess: () => {
        throw new Error("Expected rejection");
      },
    }),
  );

describe("local memory", () => {
  test("creates, replaces and forgets keyed facts across reopening with source-run provenance", async () => {
    const saved = await fixture();

    try {
      const fact = await saved.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const memory = yield* Memory;
          const session = yield* store.createSession("first-provider", "selected-model");
          const run = yield* store.queueRun(session.id, [{ role: "user", text: "Hello" }]);
          yield* store.startRun(run.id);
          yield* store.finishRun(run.id, {
            status: "completed",
            response,
          });

          return yield* memory.remember("answer.style", "Keep answers concise", run.id);
        }),
      );

      expect(fact.sourceRunId).not.toBeNull();
      await saved.run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          expect(yield* memory.list).toEqual([fact]);
          expect(yield* memory.snapshot({ profileBytes: 8192, factsBytes: 8192 })).toEqual({
            profile: "",
            facts: [{ key: fact.key, value: fact.value }],
          });
          yield* reject(memory.remember(fact.key, "Overwrite"), "conflict");
          const updated = yield* memory.replace(fact.key, "Explain the reasoning");
          expect(updated.sourceRunId).toBeNull();
          expect(updated.updatedAt).toBeGreaterThanOrEqual(fact.updatedAt);
        }),
      );
      await saved.run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          expect((yield* memory.list)[0]?.value).toBe("Explain the reasoning");
          yield* memory.forget(fact.key);
          yield* reject(memory.replace(fact.key, "Restore"), "not-found");
          yield* reject(memory.forget(fact.key), "not-found");
        }),
      );
      expect(await saved.run(Memory.use((memory) => memory.list))).toEqual([]);
    } finally {
      await saved.close();
    }
  });

  test("rejects invalid facts, unknown source runs and capacity overflow without changing saved values", async () => {
    const saved = await fixture();

    try {
      await saved.run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          yield* reject(memory.remember("bad key", "value"), "invalid-request");
          yield* reject(memory.remember("empty", " "), "invalid-request");
          yield* reject(memory.remember("large", "😀".repeat(1025)), "invalid-request");
          yield* reject(memory.remember("unknown", "value", "missing-run"), "not-found");
          yield* Effect.forEach(
            Array.from({ length: 128 }, (_, index) => `fact-${index}`),
            (key) => memory.remember(key, "Original"),
          );
          yield* reject(memory.remember("overflow", "value"), "conflict");
          yield* reject(memory.replace("fact-0", "😀".repeat(1025)), "invalid-request");
          expect((yield* memory.list).find((fact) => fact.key === "fact-0")?.value).toBe(
            "Original",
          );
          yield* memory.replace("fact-0", "Replacement at capacity");
          yield* memory.forget("fact-1");
          yield* memory.remember("new", "Slot freed");
          expect(yield* memory.list).toHaveLength(128);
        }),
      );
    } finally {
      await saved.close();
    }
  });

  test.each([
    { kind: "profile bytes", reason: "limit" },
    { kind: "facts bytes", reason: "limit" },
    { kind: "invalid UTF-8", reason: "storage" },
    { kind: "symlink", reason: "storage" },
  ] as const)("rejects $kind through the local snapshot operation", async ({ kind, reason }) => {
    const saved = await fixture();
    const profile = join(saved.directory, "profile.md");

    try {
      if (kind === "profile bytes") await writeFile(profile, "😀".repeat(16));

      if (kind === "invalid UTF-8") await writeFile(profile, Buffer.from([0xff]));

      if (kind === "symlink") {
        const outside = join(saved.directory, "outside.md");
        await writeFile(outside, "Not the profile");
        await symlink(outside, profile);
      }

      await saved.run(
        Effect.gen(function* () {
          const memory = yield* Memory;

          if (kind === "facts bytes")
            yield* memory.remember(
              "long",
              "A preference that exceeds the small serialized facts budget",
            );
          yield* reject(memory.snapshot({ profileBytes: 63, factsBytes: 40 }), reason);
        }),
      );
    } finally {
      await saved.close();
    }
  });
});
