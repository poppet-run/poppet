import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { applyMigrations, migrations } from "#src/migrations";

const initial = migrations.slice(0, 1);

describe("store migrations", () => {
  test("rolls back initial schema creation when a later migration fails", () => {
    using database = new Database(":memory:");

    const broken = {
      version: 2,
      name: "broken",
      sql: "CREATE TABLE partial (id INTEGER); invalid SQL;",
    };

    expect(() => applyMigrations(database, [...initial, broken])).toThrow(
      "No pending migrations were committed",
    );
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    expect(database.query("PRAGMA application_id").get()).toEqual({ application_id: 0 });
    expect(database.query("SELECT name FROM sqlite_master").all()).toEqual([]);
    expect(applyMigrations(database)).toBe(migrations.length);
  });

  test("rolls back every pending migration and ledger entry while preserving saved data", () => {
    using database = new Database(":memory:");
    applyMigrations(database, initial, 10);
    database.run(
      "INSERT INTO sessions (id, provider, model, created_at, updated_at) VALUES ('saved', 'openrouter', 'model', 1, 1)",
    );

    const next = {
      version: 2,
      name: "session-index",
      sql: "CREATE INDEX sessions_by_provider ON sessions (provider);",
    };

    const broken = {
      version: 3,
      name: "broken",
      sql: "CREATE TABLE partial (id INTEGER); invalid SQL;",
    };

    expect(() => applyMigrations(database, [...initial, next, broken], 20)).toThrow(
      "No pending migrations were committed",
    );
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(
      database.query("SELECT version, applied_at FROM schema_migrations ORDER BY version").all(),
    ).toEqual([{ version: 1, applied_at: 10 }]);
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE name IN ('partial', 'sessions_by_provider')")
        .all(),
    ).toEqual([]);
    expect(database.query("SELECT id FROM sessions").get()).toEqual({ id: "saved" });
    expect(applyMigrations(database, [...initial, next], 20)).toBe(2);
    expect(applyMigrations(database, [...initial, next], 30)).toBe(2);
    expect(
      database.query("SELECT version, applied_at FROM schema_migrations ORDER BY version").all(),
    ).toEqual([
      { version: 1, applied_at: 10 },
      { version: 2, applied_at: 20 },
    ]);
    expect(database.query("SELECT id FROM sessions").get()).toEqual({ id: "saved" });
  });

  test.each(["future-version", "changed-checksum", "missing-ledger"])(
    "rejects %s before applying further changes",
    (failure) => {
      using database = new Database(":memory:");
      applyMigrations(database);

      if (failure === "future-version") database.run("PRAGMA user_version = 99");
      else if (failure === "changed-checksum")
        database.run("UPDATE schema_migrations SET checksum = 'changed' WHERE version = 1");
      else database.run("DELETE FROM schema_migrations WHERE version = 1");
      expect(() => applyMigrations(database)).toThrow("unsupported or changed migration history");
      expect(
        database.query("SELECT name FROM sqlite_master WHERE name = 'sessions'").get(),
      ).toEqual({ name: "sessions" });
    },
  );

  test("does not claim an unrelated database", () => {
    using unrelated = new Database(":memory:");
    unrelated.run("CREATE TABLE other_data (id INTEGER)");
    expect(() => applyMigrations(unrelated)).toThrow("unsupported or changed migration history");
    expect(
      unrelated.query("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get(),
    ).toBeNull();
  });
});
