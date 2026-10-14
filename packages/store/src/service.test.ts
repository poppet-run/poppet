import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { type Completion, type Message, type ProviderId } from "@poppet/provider";
import { Effect, Fiber, Layer } from "effect";

import { StoreError } from "#src/errors";
import { applyMigrations, migrations } from "#src/migrations";
import { Store, StoreLive } from "#src/service";

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-store-"));
  const path = join(directory, "store/poppet.sqlite");

  const layer = StoreLive.pipe(
    Layer.provide(
      Layer.succeed(AppConfig, {
        applicationName: "Test",
        dataDirectory: directory,
        notesDirectory: join(directory, "notes"),
        provider: "openai-chatgpt",
        model: null,
      }),
    ),
  );

  const run = <A>(program: Effect.Effect<A, StoreError, Store>) =>
    Effect.runPromise(program.pipe(Effect.provide(layer)));

  return {
    directory,
    path,
    layer,
    run,
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

const responseFor = (provider: ProviderId, text = "Complete"): Completion => ({
  output: [{ type: "text", text }],
  continuation: {
    version: 1,
    provider,
    model: "selected-model",
    data: { protocol: "test", opaque: ["provider-continuation", { signature: "preserve" }] },
  },
  finishReason: "stop",
  usage: { inputTokens: 10, outputTokens: 2 },
});

const user: Message = { role: "user", text: "Hello" };

const reject = <A>(operation: Effect.Effect<A, StoreError>, reason: StoreError["reason"]) =>
  operation.pipe(
    Effect.match({
      onFailure: (error) => expect(error.reason).toBe(reason),
      onSuccess: () => {
        throw new Error("Expected rejection");
      },
    }),
  );

describe("conversation store", () => {
  test.each(["openai-chatgpt", "opencode-go", "openrouter"] as const)(
    "persists %s messages, tools, continuation and completed runs across reopening",
    async (provider) => {
      const fixtureStore = await fixture();

      try {
        const response = responseFor(provider);

        const exchange: ReadonlyArray<Message> = [
          {
            role: "assistant",
            output: [
              {
                type: "tool-call",
                callId: "call-1",
                name: "read_note",
                namespace: "notes",
                arguments: '{"path":"test.md"}',
              },
            ],
            continuation: response.continuation,
          },
          { role: "tool", callId: "call-1", output: "A note" },
        ];

        const saved = await fixtureStore.run(
          Effect.gen(function* () {
            const store = yield* Store;
            const session = yield* store.createSession(provider, "selected-model");
            const pending = yield* store.queueRun(session.id, [user]);
            expect(pending).toMatchObject({
              status: "pending",
              provider,
              model: "selected-model",
              startedAt: null,
              result: null,
            });
            const running = yield* store.startRun(pending.id);
            expect(running.status).toBe("running");
            yield* store.appendMessages({
              sessionId: session.id,
              runId: pending.id,
              messages: exchange,
            });
            const completed = yield* store.finishRun(pending.id, { status: "completed", response });

            return { session, completed };
          }),
        );

        await fixtureStore.run(
          Effect.gen(function* () {
            const store = yield* Store;
            expect(yield* store.session(saved.session.id)).toMatchObject({
              provider,
              model: "selected-model",
            });
            expect(yield* store.run(saved.completed.id)).toEqual(saved.completed);
            expect(yield* store.runs(saved.session.id)).toEqual([saved.completed]);
            const messages = yield* store.messages(saved.session.id);
            expect(messages.map((entry) => entry.position)).toEqual([0, 1, 2, 3]);
            expect(messages.every((entry) => entry.runId === saved.completed.id)).toBe(true);
            expect(messages.map((entry) => entry.message)).toEqual([
              user,
              ...exchange,
              { role: "assistant", output: response.output, continuation: response.continuation },
            ]);
            expect(yield* store.status).toMatchObject({
              schemaVersion: 2,
              sessions: 1,
              messages: 4,
              runs: 1,
            });
          }),
        );
        expect((await stat(join(fixtureStore.directory, "store"))).mode & 0o777).toBe(0o700);
        expect((await stat(fixtureStore.path)).mode & 0o777).toBe(0o600);
        expect(await readdir(join(fixtureStore.directory, "store"))).not.toContain("owner.lock");
      } finally {
        await fixtureStore.close();
      }
    },
  );

  test("rolls back partial input and completion writes when SQLite rejects a later operation", async () => {
    const fixtureStore = await fixture();

    try {
      await fixtureStore.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const session = yield* store.createSession("openrouter", "selected-model");
          using injected = new Database(fixtureStore.path);
          injected.run(
            `CREATE TRIGGER reject_second_message BEFORE INSERT ON messages WHEN NEW.position = 1 BEGIN SELECT RAISE(ABORT, 'secret-sql-failure'); END`,
          );

          const failure = yield* store
            .queueRun(session.id, [user, user])
            .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null }));

          expect(failure).toMatchObject({ reason: "storage" });
          expect(JSON.stringify(failure)).not.toContain("secret-sql-failure");
          expect(yield* store.status).toMatchObject({ messages: 0, runs: 0 });
          expect(yield* store.session(session.id)).toEqual(session);
          injected.run("DROP TRIGGER reject_second_message");
          const run = yield* store.queueRun(session.id, [user]);
          yield* store.startRun(run.id);
          injected.run(
            `CREATE TRIGGER reject_completion BEFORE UPDATE ON runs WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'secret-sql-failure'); END`,
          );

          const failedCompletion = yield* store
            .finishRun(run.id, { status: "completed", response: responseFor("openrouter") })
            .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null }));

          expect(failedCompletion).toMatchObject({ reason: "storage" });
          expect(yield* store.run(run.id)).toMatchObject({ status: "running", result: null });
          expect((yield* store.messages(session.id)).map((entry) => entry.message)).toEqual([user]);
          injected.run("DROP TRIGGER reject_completion");
          expect(
            (yield* store.finishRun(run.id, {
              status: "completed",
              response: responseFor("openrouter"),
            })).status,
          ).toBe("completed");
        }),
      );
    } finally {
      await fixtureStore.close();
    }
  });

  test("enforces one active run, session ownership, continuation identity and terminal transitions", async () => {
    const fixtureStore = await fixture();

    try {
      await fixtureStore.run(
        Effect.gen(function* () {
          const store = yield* Store;
          const first = yield* store.createSession("openrouter", "selected-model");
          const other = yield* store.createSession("opencode-go", "selected-model");

          const foreign: Message = {
            role: "assistant",
            output: [],
            continuation: responseFor("opencode-go").continuation,
          };

          yield* reject(store.queueRun(first.id, [foreign]), "invalid-request");
          expect(yield* store.status).toMatchObject({ runs: 0, messages: 0 });
          const pending = yield* store.queueRun(first.id, [user]);
          yield* reject(store.queueRun(other.id, [user]), "conflict");
          yield* reject(
            store.finishRun(pending.id, { status: "failed", reason: "quota" }),
            "conflict",
          );
          yield* reject(
            store.appendMessages({ sessionId: first.id, runId: null, messages: [user] }),
            "conflict",
          );
          yield* store.startRun(pending.id);
          yield* reject(store.startRun(pending.id), "conflict");
          yield* reject(
            store.appendMessages({ sessionId: other.id, runId: pending.id, messages: [user] }),
            "conflict",
          );
          yield* reject(
            store.finishRun(pending.id, {
              status: "completed",
              response: responseFor("opencode-go"),
            }),
            "invalid-request",
          );
          const failed = yield* store.finishRun(pending.id, { status: "failed", reason: "quota" });
          expect(failed).toMatchObject({ status: "failed", failureReason: "quota", result: null });
          yield* reject(
            store.finishRun(pending.id, {
              status: "completed",
              response: responseFor("openrouter"),
            }),
            "conflict",
          );
          yield* reject(
            store.appendMessages({ sessionId: first.id, runId: pending.id, messages: [user] }),
            "conflict",
          );
          const next = yield* store.queueRun(other.id, [user]);
          expect(next.status).toBe("pending");
        }),
      );
    } finally {
      await fixtureStore.close();
    }
  });

  test.each(["pending", "running"])(
    "marks an abandoned %s run interrupted on reopening without replay",
    async (state) => {
      const fixtureStore = await fixture();

      try {
        const before = await fixtureStore.run(
          Effect.gen(function* () {
            const store = yield* Store;
            const session = yield* store.createSession("openrouter", "selected-model");
            const run = yield* store.queueRun(session.id, [user]);

            if (state === "running") yield* store.startRun(run.id);

            return run;
          }),
        );

        await fixtureStore.run(
          Effect.gen(function* () {
            const store = yield* Store;
            const abandoned = yield* store.run(before.id);
            expect(abandoned).toMatchObject({
              status: "interrupted",
              failureReason: "process-exit",
              result: null,
            });
            expect(abandoned?.finishedAt).not.toBeNull();
            expect((yield* store.messages(before.sessionId)).map((entry) => entry.message)).toEqual(
              [user],
            );
            expect((yield* store.queueRun(before.sessionId, [user])).id).not.toBe(before.id);
          }),
        );
      } finally {
        await fixtureStore.close();
      }
    },
  );

  test("rejects another owner and closes the database and lock on interruption", async () => {
    const fixtureStore = await fixture();
    const opened = Promise.withResolvers<Store["Service"]>();

    const owner = Effect.runFork(
      Effect.gen(function* () {
        const store = yield* Store;
        opened.resolve(store);
        yield* Effect.never;
      }).pipe(Effect.provide(fixtureStore.layer)),
    );

    try {
      const borrowed = await opened.promise;
      await expect(fixtureStore.run(Store.use((store) => store.status))).rejects.toMatchObject({
        reason: "busy",
      });
      await Effect.runPromise(Fiber.interrupt(owner));
      await expect(Effect.runPromise(borrowed.status)).rejects.toMatchObject({ reason: "storage" });
      expect(await readdir(join(fixtureStore.directory, "store"))).not.toContain("owner.lock");
      expect(await fixtureStore.run(Store.use((store) => store.status))).toMatchObject({
        schemaVersion: 2,
      });
    } finally {
      await Effect.runPromise(Fiber.interrupt(owner));
      await fixtureStore.close();
    }
  });

  test("upgrades an earlier schema while retaining session history", async () => {
    const fixtureStore = await fixture();

    try {
      await fixtureStore.run(Store.use((store) => store.status));
      await rm(join(fixtureStore.directory, "store"), { recursive: true });
      await mkdir(join(fixtureStore.directory, "store"));
      using old = new Database(fixtureStore.path);
      old.run("PRAGMA foreign_keys = ON");
      applyMigrations(old, migrations.slice(0, 1));
      old
        .query("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)")
        .run("old-session", "openrouter", "selected-model", 1, 1);
      old
        .query(
          "INSERT INTO messages (session_id, position, created_at, payload) VALUES (?, ?, ?, ?)",
        )
        .run("old-session", 0, 1, JSON.stringify(user));
      old.close(true);
      await fixtureStore.run(
        Store.use((store) =>
          Effect.gen(function* () {
            expect((yield* store.status).schemaVersion).toBe(2);
            expect((yield* store.messages("old-session"))[0]?.message).toEqual(user);
            expect((yield* store.queueRun("old-session", [user])).provider).toBe("openrouter");
          }),
        ),
      );
    } finally {
      await fixtureStore.close();
    }
  });

  test.each(["malformed-json", "foreign-continuation"])(
    "rejects %s rows without exposing payloads",
    async (kind) => {
      const fixtureStore = await fixture();

      try {
        const session = await fixtureStore.run(
          Store.use((store) => store.createSession("openrouter", "selected-model")),
        );

        using tampered = new Database(fixtureStore.path);
        tampered
          .query(
            "INSERT INTO messages (session_id, position, created_at, payload) VALUES (?, ?, ?, ?)",
          )
          .run(
            session.id,
            0,
            1,
            kind === "malformed-json"
              ? "secret-invalid-payload"
              : JSON.stringify({
                  role: "assistant",
                  output: [],
                  continuation: responseFor("opencode-go").continuation,
                }),
          );
        tampered.close(true);

        const failure = await fixtureStore.run(
          Store.use((store) =>
            store
              .messages(session.id)
              .pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error })),
          ),
        );

        expect(failure).toMatchObject({ reason: "corrupt" });
        expect(JSON.stringify(failure)).not.toContain("secret-invalid-payload");
      } finally {
        await fixtureStore.close();
      }
    },
  );

  test("releases ownership after initialization fails and rejects database symlinks", async () => {
    const fixtureStore = await fixture();

    try {
      await fixtureStore.run(Store.use((store) => store.status));
      await writeFile(fixtureStore.path, "invalid-database");
      await expect(fixtureStore.run(Store.use((store) => store.status))).rejects.toMatchObject({
        reason: "storage",
      });
      expect(await readdir(join(fixtureStore.directory, "store"))).not.toContain("owner.lock");
      await rm(fixtureStore.path);
      const target = join(fixtureStore.directory, "unrelated");
      await writeFile(target, "do not change", { mode: 0o644 });
      await symlink(target, fixtureStore.path);
      await expect(fixtureStore.run(Store.use((store) => store.status))).rejects.toMatchObject({
        reason: "storage",
      });
      expect((await stat(target)).mode & 0o777).toBe(0o644);
    } finally {
      await fixtureStore.close();
    }
  });

  test("releases ownership when a newer database schema prevents startup", async () => {
    const fixtureStore = await fixture();

    try {
      await fixtureStore.run(Store.use((store) => store.status));
      using newer = new Database(fixtureStore.path);
      newer.run("PRAGMA user_version = 99");
      newer.close(true);
      await expect(fixtureStore.run(Store.use((store) => store.status))).rejects.toMatchObject({
        reason: "migration",
      });
      expect(await readdir(join(fixtureStore.directory, "store"))).not.toContain("owner.lock");
      using inspect = new Database(fixtureStore.path, { readonly: true });
      expect(inspect.query("PRAGMA user_version").get()).toEqual({ user_version: 99 });
    } finally {
      await fixtureStore.close();
    }
  });
});
