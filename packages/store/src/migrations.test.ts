import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { AppConfig } from "@poppet/config";
import { Effect, Exit, Layer } from "effect";
import { Migrator, SqlClient } from "effect/sql";

import { StoreDatabase, StoreDatabaseLive } from "#src/database";
import { migrate, storeSchema } from "#src/migrations";

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-migrations-"));
  const path = join(directory, "store/poppet.sqlite");

  const layer = StoreDatabaseLive.pipe(
    Layer.provide(
      Layer.succeed(AppConfig, {
        applicationName: "Test",
        dataDirectory: directory,
        provider: "first-provider",
        model: null,
      }),
    ),
  );

  const open = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* StoreDatabase;

        return true;
      }).pipe(Effect.provide(layer)),
    );

  return { directory, path, open, close: () => rm(directory, { recursive: true, force: true }) };
};

describe("StoreDatabaseLive migrations", () => {
  test("when the store is new, applies its migrations once and records them", async () => {
    const store = await fixture();

    try {
      expect(await store.open()).toBe(true);
      expect(await store.open()).toBe(true);
      using database = new Database(store.path, { readonly: true });
      expect(database.query("SELECT migration_id, name FROM effect_sql_migrations").all()).toEqual([
        { migration_id: 1, name: "baseline" },
        { migration_id: 2, name: "session_active_run" },
      ]);
      expect(
        database.query("SELECT name FROM sqlite_master WHERE name = 'sessions'").get(),
      ).toEqual({ name: "sessions" });
    } finally {
      await store.close();
    }
  });

  test.each(["older-build", "other-application"])(
    "when the database came from an %s, refuses it without changes",
    async (origin) => {
      const store = await fixture();

      try {
        await mkdir(join(store.directory, "store"), { recursive: true });

        using existing = new Database(store.path);
        existing.run(
          origin === "older-build"
            ? "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)"
            : "CREATE TABLE other_data (id INTEGER)",
        );
        existing.close();

        await expect(store.open()).rejects.toMatchObject({ reason: "migration" });
        using inspect = new Database(store.path, { readonly: true });
        expect(
          inspect.query("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
        ).toHaveLength(1);
      } finally {
        await store.close();
      }
    },
  );

  test("when a pending migration fails, commits none of the pending migrations", async () => {
    const store = await fixture();

    try {
      await mkdir(join(store.directory, "store"), { recursive: true });

      const run = (loader: Migrator.Loader) =>
        Effect.runPromise(
          SqliteMigrator.run({ loader }).pipe(
            Effect.provide(SqliteClient.layer({ filename: store.path })),
            Effect.exit,
          ),
        );

      await run(storeSchema.loader);

      const pending = Migrator.fromRecord({
        "1_baseline": Effect.void,
        "2_session_active_run": Effect.void,
        "3_index": Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE INDEX sessions_by_provider ON sessions (provider)`;
        }),
        "4_broken": Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`invalid SQL`;
        }),
      });

      expect(Exit.isFailure(await run(pending))).toBe(true);
      using database = new Database(store.path, { readonly: true });
      expect(database.query("SELECT migration_id FROM effect_sql_migrations").all()).toEqual([
        { migration_id: 1 },
        { migration_id: 2 },
      ]);
      expect(
        database.query("SELECT name FROM sqlite_master WHERE name = 'sessions_by_provider'").get(),
      ).toBeNull();
    } finally {
      await store.close();
    }
  });

  test("when a package migrates, records its own ledger and refuses a newer one", async () => {
    const store = await fixture();

    try {
      await mkdir(join(store.directory, "store"), { recursive: true });

      const schema = {
        table: "notes_migrations",
        version: 1,
        loader: Migrator.fromRecord({
          "1_notes": Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TABLE notes (id INTEGER PRIMARY KEY)`;
          }),
        }),
      };

      const run = () =>
        Effect.runPromise(
          migrate(schema).pipe(
            Effect.provide(SqliteClient.layer({ filename: store.path })),
            Effect.exit,
          ),
        );

      expect(Exit.isSuccess(await run())).toBe(true);
      expect(Exit.isSuccess(await run())).toBe(true);

      using database = new Database(store.path);
      expect(database.query("SELECT migration_id FROM notes_migrations").all()).toEqual([
        { migration_id: 1 },
      ]);
      database.run("INSERT INTO notes_migrations (migration_id, name) VALUES (2, 'future')");
      database.close();

      const refused = await run();
      expect(Exit.isFailure(refused) && JSON.stringify(refused.cause)).toContain("newer version");
    } finally {
      await store.close();
    }
  });
});
