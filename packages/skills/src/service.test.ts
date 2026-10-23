import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { Store, StoreDatabase, StoreLive } from "@poppet/store";
import { Effect, Layer } from "effect";

import { SkillError } from "#src/errors";
import { LearnedSkills, LearnedSkillsLive, containsSecret, maxLearnedSkills } from "#src/service";

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-learned-skills-"));

  const config = Layer.succeed(AppConfig, {
    applicationName: "Test",
    dataDirectory: directory,
    notesDirectory: join(directory, "notes"),
    provider: "test-provider",
    model: null,
  });

  const store = StoreLive.pipe(Layer.provideMerge(config));
  const layer = LearnedSkillsLive.pipe(Layer.provideMerge(store));

  return {
    run: <A, E>(program: Effect.Effect<A, E, LearnedSkills | Store | StoreDatabase>) =>
      Effect.runPromise(program.pipe(Effect.provide(layer))),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

const owner = { origin: "owner" } as const;

const reason = <A>(operation: Effect.Effect<A, SkillError>) =>
  operation.pipe(
    Effect.match({
      onFailure: (error) => error.reason,
      onSuccess: () => null,
    }),
  );

const sourceRun = Effect.gen(function* () {
  const store = yield* Store;
  const session = yield* store.createSession("test-provider", "test-model");

  return (yield* store.queueRun(session.id, [{ role: "user", text: "Hello" }])).id;
});

describe.concurrent("LearnedSkills", () => {
  test("when skills are created, patched, replaced, or deleted, appends each change to history", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const skills = yield* LearnedSkills;
          const runId = yield* sourceRun;
          const turn = (callId: string) => ({ origin: "turn" as const, runId, callId });

          expect(
            yield* skills.write(
              { action: "create", name: "weekly-review", content: "# Weekly review\n\nStep one." },
              turn("a"),
            ),
          ).toEqual({ name: "weekly-review", revision: 1, action: "create", deleted: false });

          yield* skills.write(
            {
              action: "patch",
              name: "weekly-review",
              old: "Step one.",
              new: "Step one, then two.",
              expectedRevision: 1,
            },
            turn("b"),
          );
          expect((yield* skills.get("weekly-review"))?.content).toBe(
            "# Weekly review\n\nStep one, then two.",
          );

          yield* skills.write(
            { action: "replace", name: "weekly-review", content: "# Weekly review\n\nNew." },
            owner,
          );
          expect(
            yield* skills.write({ action: "delete", name: "weekly-review" }, owner),
          ).toMatchObject({ revision: 4, deleted: true });
          expect(yield* skills.get("weekly-review")).toBeNull();
          expect(yield* skills.list).toEqual([]);

          const history = yield* skills.history("weekly-review");
          expect(history.map(({ revision, action, origin }) => [revision, action, origin])).toEqual(
            [
              [1, "create", "turn"],
              [2, "patch", "turn"],
              [3, "replace", "owner"],
              [4, "delete", "owner"],
            ],
          );
          expect(history[0]).toMatchObject({ sourceRunId: runId, sourceCallId: "a" });
          expect(history[3]).toMatchObject({ content: null, sourceRunId: null });

          // Recreating continues the same revision sequence.
          expect(
            yield* skills.write(
              { action: "create", name: "weekly-review", content: "Again" },
              owner,
            ),
          ).toMatchObject({ revision: 5 });
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when reverting to earlier content or tombstones, records a new revision", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const skills = yield* LearnedSkills;
          yield* skills.write({ action: "create", name: "review", content: "First" }, owner);
          yield* skills.write({ action: "replace", name: "review", content: "Second" }, owner);

          expect(yield* skills.revert("review", 1)).toEqual({
            name: "review",
            revision: 3,
            action: "revert",
            deleted: false,
          });
          expect((yield* skills.get("review"))?.content).toBe("First");
          expect(yield* reason(skills.revert("review", 3))).toBe("conflict");

          yield* skills.write({ action: "delete", name: "review" }, owner);
          expect(yield* skills.revert("review", 2)).toMatchObject({ revision: 5 });
          expect((yield* skills.get("review"))?.content).toBe("Second");
          expect(yield* skills.revert("review", 4)).toMatchObject({ revision: 6, deleted: true });
          expect(yield* reason(skills.revert("review", 4))).toBe("conflict");
          expect(yield* reason(skills.revert("review", 99))).toBe("not-found");
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when revisions are stale, patches ambiguous, or skills conflicting or missing, rejects the change", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const skills = yield* LearnedSkills;
          yield* skills.write({ action: "create", name: "review", content: "a a b" }, owner);

          expect(
            yield* reason(skills.write({ action: "create", name: "review", content: "x" }, owner)),
          ).toBe("conflict");
          expect(
            yield* reason(
              skills.write(
                { action: "replace", name: "review", content: "x", expectedRevision: 2 },
                owner,
              ),
            ),
          ).toBe("conflict");

          for (const old of ["a", "missing", ""])
            expect(
              yield* reason(
                skills.write({ action: "patch", name: "review", old, new: "c" }, owner),
              ),
            ).toBe("invalid-request");

          expect(
            yield* reason(
              skills.write({ action: "patch", name: "review", old: "a a b", new: "" }, owner),
            ),
          ).toBe("invalid-request");
          expect(yield* reason(skills.write({ action: "delete", name: "absent" }, owner))).toBe(
            "not-found",
          );
          expect(
            yield* reason(skills.write({ action: "create", name: "../x", content: "x" }, owner)),
          ).toBe("invalid-request");
          expect(
            yield* reason(
              skills.write({ action: "create", name: "big", content: "x".repeat(8193) }, owner),
            ),
          ).toBe("invalid-request");
          expect((yield* skills.history("review")).length).toBe(1);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when the model writes skills, requires an existing run, prevents duplicate calls, and rejects secrets", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const skills = yield* LearnedSkills;
          const runId = yield* sourceRun;
          const source = { origin: "turn", runId, callId: "call" } as const;

          expect(
            yield* reason(
              skills.write(
                { action: "create", name: "a", content: "x" },
                { origin: "review", runId: "missing", callId: "call" },
              ),
            ),
          ).toBe("not-found");
          yield* skills.write({ action: "create", name: "a", content: "x" }, source);
          expect(
            yield* reason(skills.write({ action: "create", name: "b", content: "x" }, source)),
          ).toBe("conflict");

          const secret = "Use token ghp_abcdefghijklmnopqrstuvwxyz0123456789";
          expect(
            yield* reason(
              skills.write(
                { action: "create", name: "c", content: secret },
                { ...source, callId: "other" },
              ),
            ),
          ).toBe("invalid-request");
          // The owner may save anything they choose.
          yield* skills.write({ action: "create", name: "c", content: secret }, owner);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test(`when learned skills reach ${maxLearnedSkills}, rejects further creation`, async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const skills = yield* LearnedSkills;

          for (let index = 0; index < maxLearnedSkills; index++)
            yield* skills.write({ action: "create", name: `s${index}`, content: "x" }, owner);

          expect(
            yield* reason(skills.write({ action: "create", name: "extra", content: "x" }, owner)),
          ).toBe("limit");
          expect((yield* skills.list).length).toBe(maxLearnedSkills);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test.each([
    ["-----BEGIN OPENSSH PRIVATE KEY-----", true],
    ["sk-proj-abcdefghijklmnopqrstuvwxyz", true],
    ["AKIAABCDEFGHIJKLMNOP", true],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123", true],
    ["Use the API key saved in the provider settings.", false],
    ["Ask the skeptic.", false],
  ])("when text contains secret-shaped content %j, detects it", (text, expected) => {
    expect(containsSecret(text)).toBe(expected);
  });
});
