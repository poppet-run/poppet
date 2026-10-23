import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { applyMigrations, migrations } from "#src/migrations";

const initial = migrations.slice(0, 1);

describe("applyMigrations", () => {
  test("when monitoring is retired, stops checks and queued alerts while preserving cron and history", () => {
    using database = new Database(":memory:");
    applyMigrations(database, migrations.slice(0, 8));

    for (const [id, monitor, status] of [
      ["cron", 0, "pending"],
      ["pending", 1, "pending"],
      ["running", 1, "running"],
      ["saved", 1, "completed"],
    ] as const) {
      database
        .query(
          "INSERT INTO jobs (id, name, prompt, provider, model, workload, schedule, next_at, created_at, monitor) VALUES (?, ?, 'Read release', 'openrouter', 'model', 'assistant', '{}', 100, 1, ?)",
        )
        .run(id, id, monitor);
      database
        .query(
          "INSERT INTO job_occurrences (id, job_id, revision, definition, scheduled_at, available_at, status) VALUES (?, ?, 0, '{}', 100, 100, ?)",
        )
        .run(id, id, status);
    }

    database.run(
      "INSERT INTO job_monitor_results (occurrence_id, job_id, value, summary, sources, observed_at, decision) VALUES ('saved', 'saved', 'v1', 'Release', '[]', 1, 'baseline')",
    );

    for (const [id, occurrence] of [
      [1, "saved"],
      [2, "cron"],
    ] as const) {
      database
        .query(
          "INSERT INTO gateway_inbox (id, adapter, account, external_id, payload, run_id, state, occurrence_id) VALUES (?, 'telegram', 'bot', ?, '{}', ?, 'completed', ?)",
        )
        .run(id, occurrence, occurrence, occurrence);

      for (const [position, state] of [
        [0, "pending"],
        [1, "sending"],
        [2, "sent"],
      ] as const)
        database
          .query(
            "INSERT INTO gateway_deliveries (inbox_id, position, text, state) VALUES (?, ?, 'Saved alert', ?)",
          )
          .run(id, position, state);
    }

    applyMigrations(database);
    expect(database.query("SELECT id, paused, next_at FROM jobs ORDER BY id").all()).toEqual([
      { id: "cron", paused: 0, next_at: 100 },
      { id: "pending", paused: 1, next_at: null },
      { id: "running", paused: 1, next_at: null },
      { id: "saved", paused: 1, next_at: null },
    ]);
    expect(database.query("SELECT id, status FROM job_occurrences ORDER BY id").all()).toEqual([
      { id: "cron", status: "pending" },
      { id: "pending", status: "cancelled" },
      { id: "running", status: "interrupted" },
      { id: "saved", status: "completed" },
    ]);
    expect(
      database
        .query("SELECT state FROM gateway_deliveries WHERE inbox_id = 1 ORDER BY position")
        .all(),
    ).toEqual([{ state: "failed" }, { state: "uncertain" }, { state: "sent" }]);
    expect(
      database
        .query("SELECT state FROM gateway_deliveries WHERE inbox_id = 2 ORDER BY position")
        .all(),
    ).toEqual([{ state: "pending" }, { state: "sending" }, { state: "sent" }]);
    expect(database.query("SELECT value FROM job_monitor_results").get()).toEqual({ value: "v1" });
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(applyMigrations(database)).toBe(migrations.length);
  });

  test("when a later migration fails during initial setup, rolls back schema creation", () => {
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

  test("when a pending migration fails, rolls back pending changes and ledger entries while preserving data", () => {
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
    "when the migration ledger has %s, rejects further changes",
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

  test("when a database belongs to another application, refuses to claim it", () => {
    using unrelated = new Database(":memory:");
    unrelated.run("CREATE TABLE other_data (id INTEGER)");
    expect(() => applyMigrations(unrelated)).toThrow("unsupported or changed migration history");
    expect(
      unrelated.query("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get(),
    ).toBeNull();
  });

  test("when memory history is added, backfills fact origins and first revisions", () => {
    using database = new Database(":memory:");
    applyMigrations(database, migrations.slice(0, 6), 10);
    database.run(
      "INSERT INTO sessions (id, provider, model, created_at, updated_at) VALUES ('s', 'openrouter', 'model', 1, 1)",
    );
    database.run(
      "INSERT INTO runs (id, session_id, provider, model, status, created_at) VALUES ('r', 's', 'openrouter', 'model', 'pending', 1)",
    );
    database.run(
      "INSERT INTO memories (project, key, value, source_run_id, updated_at) VALUES ('', 'cli.fact', 'From CLI', NULL, 5), ('', 'chat.fact', 'From chat', 'r', 6)",
    );

    applyMigrations(database, migrations, 20);

    expect(database.query("SELECT key, origin FROM memories ORDER BY key").all()).toEqual([
      { key: "chat.fact", origin: "turn" },
      { key: "cli.fact", origin: "cli" },
    ]);
    expect(
      database
        .query(
          "SELECT key, revision, action, value, origin, source_run_id AS run, created_at AS at FROM memory_revisions ORDER BY key",
        )
        .all(),
    ).toEqual([
      {
        key: "chat.fact",
        revision: 1,
        action: "remember",
        value: "From chat",
        origin: "turn",
        run: "r",
        at: 6,
      },
      {
        key: "cli.fact",
        revision: 1,
        action: "remember",
        value: "From CLI",
        origin: "cli",
        run: null,
        at: 5,
      },
    ]);
  });
});
