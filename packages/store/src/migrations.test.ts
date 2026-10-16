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
        .query(
          "SELECT name FROM sqlite_master WHERE name IN ('partial', 'one_active_run', 'session_search', 'searchable_messages', 'index_completed_run')",
        )
        .all(),
    ).toEqual([]);
    expect(database.query("SELECT id FROM sessions").get()).toEqual({ id: "saved" });
    expect(applyMigrations(database)).toBe(migrations.length);
    expect(applyMigrations(database)).toBe(migrations.length);
  });

  test("upgrades existing sessions and tasks with no skill selected", () => {
    using database = new Database(":memory:");
    applyMigrations(database, migrations.slice(0, 9));
    database.run(
      "INSERT INTO sessions (id, provider, model, created_at, updated_at) VALUES ('saved', 'test', 'model', 1, 1)",
    );
    database.run(`INSERT INTO jobs (id, name, prompt, provider, model, workload, schedule, created_at)
      VALUES ('job', 'Review', 'Review notes', 'test', 'model', 'assistant', '{"type":"once","at":1}', 1)`);
    applyMigrations(database);
    expect(database.query("SELECT skill FROM sessions").get()).toEqual({ skill: null });
    expect(database.query("SELECT skill FROM jobs").get()).toEqual({ skill: null });
  });

  test("backfills completed conversation text from schema 8 without indexing intermediate or failed content", () => {
    using database = new Database(":memory:");
    applyMigrations(database, migrations.slice(0, 8));
    database.run(
      "INSERT INTO sessions (id, provider, model, created_at, updated_at) VALUES ('saved', 'test', 'model', 1, 1)",
    );
    database.run(`INSERT INTO runs (id, session_id, provider, model, status, created_at, started_at, finished_at, result)
      VALUES ('done', 'saved', 'test', 'model', 'completed', 1, 1, 1, '{}')`);
    database.run(`INSERT INTO runs (id, session_id, provider, model, status, created_at, finished_at, failure_reason)
      VALUES ('failed', 'saved', 'test', 'model', 'failed', 1, 1, 'test')`);

    const messages = [
      { role: "user", text: "backfilled question" },
      {
        role: "assistant",
        output: [{ type: "text", text: "intermediate" }],
        continuation: { secret: "continuation" },
      },
      { role: "tool", output: "tool output" },
      {
        role: "assistant",
        output: [
          { type: "text", text: "backfilled" },
          { type: "text", text: "answer" },
        ],
        continuation: { secret: "continuation" },
      },
      { role: "user", text: "failed input" },
    ];

    for (const [position, message] of messages.entries())
      database
        .query(
          "INSERT INTO messages (session_id, run_id, position, created_at, payload) VALUES ('saved', ?, ?, 1, ?)",
        )
        .run(position === 4 ? "failed" : "done", position, JSON.stringify(message));

    applyMigrations(database);
    expect(database.query("SELECT rowid, text FROM session_search ORDER BY rowid").all()).toEqual([
      { rowid: 1, text: "backfilled question" },
      { rowid: 4, text: "backfilled\nanswer" },
    ]);
    expect(
      database
        .query("SELECT rowid FROM session_search WHERE session_search MATCH ? ORDER BY rowid")
        .all('"backfilled"'),
    ).toEqual([{ rowid: 1 }, { rowid: 4 }]);
    applyMigrations(database);
    expect(database.query("SELECT count(*) AS count FROM session_search").get()).toEqual({
      count: 2,
    });
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
