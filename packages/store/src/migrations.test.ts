import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { applyMigrations, migrations } from "#src/migrations";

describe("store migrations", () => {
  test("rolls back every pending migration and ledger entry on a later failure", () => {
    using database = new Database(":memory:");
    applyMigrations(database, migrations.slice(0, 1));
    database.run("INSERT INTO sessions VALUES ('saved', 'openrouter', 'model', 1, 1)");

    const broken = {
      version: migrations.length + 1,
      name: "broken",
      sql: "CREATE TABLE partial (id INTEGER); invalid SQL;",
    };

    expect(() => applyMigrations(database, [...migrations, broken])).toThrow(
      "No pending migrations were committed",
    );
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(database.query("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 },
    ]);
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE name IN ('partial', 'one_active_run')")
        .all(),
    ).toEqual([]);
    expect(database.query("SELECT id FROM sessions").get()).toEqual({ id: "saved" });
    expect(applyMigrations(database)).toBe(migrations.length);
    expect(applyMigrations(database)).toBe(migrations.length);
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

  test("does not claim an unrelated database or accept a noncontiguous plan", () => {
    using unrelated = new Database(":memory:");
    unrelated.run("CREATE TABLE other_data (id INTEGER)");
    expect(() => applyMigrations(unrelated)).toThrow("unsupported or changed migration history");
    expect(
      unrelated.query("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get(),
    ).toBeNull();
    using empty = new Database(":memory:");
    expect(() => applyMigrations(empty, migrations.slice(1))).toThrow(
      "unsupported or changed migration history",
    );
  });
});
