import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import type { Completion } from "@poppet/provider";
import { Store, StoreDatabase, StoreLive } from "@poppet/store";
import { Effect, Layer } from "effect";

import { LocalMemoryLive } from "#src/local";
import { Memory, MemoryError } from "#src/service";

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-local-memory-"));

  const config = Layer.succeed(AppConfig, {
    applicationName: "Test",
    dataDirectory: directory,
    provider: "first-provider",
    model: null,
  });

  const store = StoreLive.pipe(Layer.provideMerge(config));
  const layer = LocalMemoryLive.pipe(Layer.provideMerge(store));

  return {
    directory,
    run: <A, E>(program: Effect.Effect<A, E, Memory | Store | StoreDatabase>) =>
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

describe.concurrent("LocalMemoryLive", () => {
  test("when keyed facts change across reopening, preserves create, replace, forget, and source-run provenance", async () => {
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
          expect(
            yield* memory.snapshot({ soulBytes: 8192, profileBytes: 8192, factsBytes: 8192 }),
          ).toEqual({
            soul: "",
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

  test("when facts, source runs, or capacity are invalid, rejects changes without altering saved values", async () => {
    const saved = await fixture();

    try {
      await saved.run(
        Effect.gen(function* () {
          const memory = yield* Memory;
          yield* reject(memory.remember("bad key", "value"), "invalid-request");
          yield* reject(memory.remember("empty", " "), "invalid-request");
          yield* reject(memory.remember("large", "😀".repeat(1025)), "invalid-request");
          yield* reject(memory.remember("unknown", "value", "missing-run"), "not-found");
          const { database } = yield* StoreDatabase;
          // Seed in one transaction, then exercise real writes at the capacity boundary.
          database.transaction(() => {
            using insert = database.prepare(
              "INSERT INTO memories (key, value, source_run_id, updated_at) VALUES (?, ?, NULL, ?)",
            );

            for (let index = 0; index < 127; index++) insert.run(`fact-${index}`, "Original", 1);
          })();
          yield* memory.remember("fact-127", "Original");
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
    ...["profile.md", "soul.md"].flatMap((file) => [
      { file, kind: "file bytes", reason: "limit" } as const,
      { file, kind: "invalid UTF-8", reason: "storage" } as const,
      { file, kind: "NUL", reason: "storage" } as const,
      { file, kind: "symlink", reason: "storage" } as const,
      { file, kind: "directory", reason: "storage" } as const,
    ]),
    { file: "profile.md", kind: "facts bytes", reason: "limit" } as const,
  ])("when $file is $kind, rejects the local snapshot", async ({ file, kind, reason }) => {
    const saved = await fixture();
    const path = join(saved.directory, file);

    try {
      if (kind === "file bytes") await writeFile(path, "😀".repeat(16));

      if (kind === "invalid UTF-8") await writeFile(path, Buffer.from([0xff]));

      if (kind === "NUL") await writeFile(path, "Invalid\0text");

      if (kind === "directory") await mkdir(path);

      if (kind === "symlink") {
        const outside = join(saved.directory, "outside.md");
        await writeFile(outside, "Not the profile");
        await symlink(outside, path);
      }

      await saved.run(
        Effect.gen(function* () {
          const memory = yield* Memory;

          if (kind === "facts bytes")
            yield* memory.remember(
              "long",
              "A preference that exceeds the small serialized facts budget",
            );
          yield* reject(
            memory.snapshot({ soulBytes: 63, profileBytes: 63, factsBytes: 40 }),
            reason,
          );
        }),
      );
    } finally {
      await saved.close();
    }
  });

  test("when facts change or revert, records their origins and appends revisions", async () => {
    const saved = await fixture();

    try {
      await saved.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const memory = yield* Memory;
          const session = yield* store.createSession("first-provider", "selected-model");
          const run = yield* store.queueRun(session.id, [{ role: "user", text: "Hello" }]);

          yield* memory.remember("answer.style", "Concise");
          yield* memory.replace("answer.style", "Detailed", run.id);
          yield* memory.forget("answer.style", run.id, "review");

          const history = yield* memory.history("answer.style");
          expect(
            history.map(({ revision, action, value, origin, sourceRunId }) => ({
              revision,
              action,
              value,
              origin,
              sourceRunId,
            })),
          ).toEqual([
            { revision: 1, action: "remember", value: "Concise", origin: "cli", sourceRunId: null },
            {
              revision: 2,
              action: "replace",
              value: "Detailed",
              origin: "turn",
              sourceRunId: run.id,
            },
            { revision: 3, action: "forget", value: null, origin: "review", sourceRunId: run.id },
          ]);

          expect(yield* memory.revert("answer.style", 1)).toMatchObject({
            value: "Concise",
            origin: "cli",
            sourceRunId: null,
          });
          expect((yield* memory.list).map(({ key, origin }) => ({ key, origin }))).toEqual([
            { key: "answer.style", origin: "cli" },
          ]);
          yield* reject(memory.revert("answer.style", 4), "conflict");
          expect(yield* memory.revert("answer.style", 3)).toBeNull();
          expect(yield* memory.list).toEqual([]);
          yield* reject(memory.revert("answer.style", 3), "conflict");
          yield* reject(memory.revert("answer.style", 99), "not-found");
          expect((yield* memory.history("answer.style")).at(-1)).toMatchObject({
            revision: 5,
            action: "forget",
          });

          yield* reject(memory.remember("bad", "No run", null, "review"), "invalid-request");
          yield* reject(memory.forget("missing"), "not-found");
          expect(yield* memory.history("bad")).toEqual([]);

          // Project history is separate from global history.
          const project = memory.forProject("acorn");
          yield* project.remember("answer.style", "Project");
          expect((yield* project.history("answer.style")).length).toBe(1);
        }),
      );
    } finally {
      await saved.close();
    }
  });
});
