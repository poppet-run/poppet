import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { Schema } from "effect";

import { applyMigrations, migrations } from "#src/migrations";

const initial = migrations.slice(0, 1);

describe("store migrations", () => {
  test("project migration preserves global facts and legacy snapshots and rolls back atomically", () => {
    using database = new Database(":memory:");
    database.run("PRAGMA foreign_keys = ON");
    const prior = migrations.slice(0, 4);
    applyMigrations(database, prior);
    database.run(
      "INSERT INTO memories (key, value, source_run_id, updated_at) VALUES ('style', 'Existing global fact', NULL, 7)",
    );
    database.run(
      "INSERT INTO sessions (id, provider, model, created_at, updated_at) VALUES ('old', 'test', 'model', 1, 1)",
    );
    database.run(`INSERT INTO jobs (id, name, prompt, provider, model, workload, schedule, created_at)
      VALUES ('old-task', 'Old', 'Review', 'test', 'model', 'assistant', '{"type":"once","at":10}', 1)`);

    const definition = JSON.stringify({
      name: "Old",
      prompt: "Review",
      provider: "test",
      model: "model",
      workload: "assistant",
      schedule: { type: "once", at: 10 },
      monitor: false,
      skill: null,
    });

    database
      .query(
        "INSERT INTO job_occurrences (id, job_id, revision, scheduled_at, available_at, status, definition) VALUES ('old-occurrence', 'old-task', 0, 10, 10, 'pending', ?)",
      )
      .run(definition);
    const next = migrations[4]!;
    expect(() =>
      applyMigrations(database, [...prior, { ...next, sql: `${next.sql}\ninvalid SQL;` }]),
    ).toThrow("No pending migrations");
    expect(database.query("SELECT * FROM memories").get()).toEqual({
      key: "style",
      value: "Existing global fact",
      source_run_id: null,
      updated_at: 7,
    });
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    applyMigrations(database);
    expect(database.query("SELECT * FROM memories").get()).toEqual({
      project: "",
      key: "style",
      value: "Existing global fact",
      source_run_id: null,
      updated_at: 7,
    });
    expect(database.query("SELECT project FROM sessions").get()).toEqual({ project: null });
    expect(database.query("SELECT project FROM jobs").get()).toEqual({ project: null });
    expect(
      database
        .query("SELECT json_type(definition, '$.project') AS kind FROM job_occurrences")
        .get(),
    ).toEqual({ kind: "null" });
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  test("upgrades text-only inbox records in place and rolls back the attachment migration atomically", () => {
    using database = new Database(":memory:");
    database.run("PRAGMA foreign_keys = ON");
    const prior = migrations.slice(0, 3);
    applyMigrations(database, prior);

    const payload = JSON.stringify({
      messageId: "1",
      scopeId: "owner",
      parentId: "owner",
      conversationId: "owner",
      senderId: "owner",
      text: "Legacy text",
      mentioned: false,
    });

    database
      .query(
        "INSERT INTO gateway_inbox (adapter, account, external_id, payload, conversation_id, run_id, state) VALUES ('telegram', 'bot', '1', ?, 'owner', 'reserved-run', 'queued')",
      )
      .run(payload);
    const next = migrations[3]!;
    expect(() =>
      applyMigrations(database, [...prior, { ...next, sql: `${next.sql}\ninvalid SQL;` }]),
    ).toThrow("No pending migrations");
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    expect(
      database.query("SELECT name FROM sqlite_master WHERE name = 'gateway_attachments'").get(),
    ).toBeNull();
    applyMigrations(database);
    expect(database.query("SELECT payload, run_id, state FROM gateway_inbox").get()).toEqual({
      payload,
      run_id: "reserved-run",
      state: "queued",
    });
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  test("backfills immutable occurrence definitions and preserves monitor children/order under foreign keys, including rollback", () => {
    using database = new Database(":memory:");
    database.run("PRAGMA foreign_keys = ON");
    applyMigrations(database, migrations.slice(0, 2));
    database.run(`INSERT INTO jobs (id, name, prompt, provider, model, workload, schedule, created_at, monitor, skill)
      VALUES ('watch', 'Release', 'Read release.md', 'openrouter', 'model', 'coding',
        '{"type":"cron","expression":"0 9 * * *","timezone":"Europe/London"}', 1, 1, '{"name":"release","content":"Read the current tag"}')`);
    database.run(`INSERT INTO job_occurrences (id, job_id, scheduled_at, status, finished_at, destination) VALUES
      ('first', 'watch', 2, 'completed', 3, NULL), ('second', 'watch', 4, 'completed', 5, NULL),
      ('queued', 'watch', 6, 'pending', NULL, NULL)`);

    const destination = {
      adapter: "discord",
      account: "bot",
      ownerId: "owner",
      scopeId: "guild",
      parentId: "parent",
      conversationId: "original-thread",
    };

    database
      .query("UPDATE job_occurrences SET destination = ? WHERE id = 'queued'")
      .run(JSON.stringify(destination));
    database
      .query("UPDATE jobs SET destination = ?")
      .run(JSON.stringify({ ...destination, conversationId: "different-thread" }));
    database.run(`INSERT INTO job_monitor_results
      (id, occurrence_id, job_id, value, summary, sources, observed_at, previous_value, decision, notification_text) VALUES
      (10, 'first', 'watch', 'A', 'First', '[]', 3, NULL, 'baseline', NULL),
      (20, 'second', 'watch', 'B', 'Next', '[]', 5, 'A', 'changed', 'Saved notification')`);
    const results = database.query("SELECT * FROM job_monitor_results ORDER BY id").all();
    const broken = { ...migrations[2]!, sql: `${migrations[2]!.sql}\ninvalid SQL;` };
    expect(() => applyMigrations(database, [...migrations.slice(0, 2), broken])).toThrow(
      "No pending migrations were committed",
    );
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(database.query("SELECT * FROM job_monitor_results ORDER BY id").all()).toEqual(results);
    expect(applyMigrations(database)).toBe(migrations.length);
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.query("SELECT * FROM job_monitor_results ORDER BY id").all()).toEqual(results);
    expect(database.query("SELECT revision, monitor_baseline_after FROM jobs").get()).toEqual({
      revision: 0,
      monitor_baseline_after: 0,
    });

    const rows = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          scheduled_at: Schema.Natural,
          available_at: Schema.Natural,
          definition: Schema.String,
          destination: Schema.NullOr(Schema.String),
        }),
      ),
    )(
      database
        .query(
          "SELECT id, scheduled_at, available_at, definition, destination FROM job_occurrences ORDER BY scheduled_at",
        )
        .all(),
    );

    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ id: "queued", scheduled_at: 6, available_at: 6 });
    expect(rows[2]?.destination).toBe(JSON.stringify(destination));
    expect(JSON.parse(rows[2]!.definition)).toEqual({
      name: "Release",
      prompt: "Read release.md",
      provider: "openrouter",
      model: "model",
      workload: "coding",
      monitor: true,
      skill: { name: "release", content: "Read the current tag" },
      project: null,
      schedule: { type: "cron", expression: "0 9 * * *", timezone: "Europe/London" },
    });
    database.run("DELETE FROM job_occurrences WHERE id = 'first'");
    expect(database.query("SELECT id FROM job_monitor_results").all()).toEqual([{ id: 20 }]);
  });

  test("upgrades version 1 without changing existing tasks or making past reports into monitors", () => {
    using database = new Database(":memory:");
    applyMigrations(database, initial);
    database.run(`INSERT INTO jobs (id, name, prompt, provider, model, workload, schedule, created_at)
      VALUES ('report', 'Report', 'Saved prompt', 'openrouter', 'model', 'assistant', '{"type":"cron","expression":"0 9 * * *","timezone":"UTC"}', 1)`);
    database.run(
      "INSERT INTO job_occurrences (id, job_id, scheduled_at, status, finished_at) VALUES ('saved', 'report', 2, 'completed', 3)",
    );
    expect(applyMigrations(database)).toBe(migrations.length);
    expect(database.query("SELECT id, prompt, monitor FROM jobs").get()).toEqual({
      id: "report",
      prompt: "Saved prompt",
      monitor: 0,
    });
    expect(database.query("SELECT id, status FROM job_occurrences").get()).toEqual({
      id: "saved",
      status: "completed",
    });
    expect(database.query("SELECT * FROM job_monitor_results").all()).toEqual([]);
    expect(applyMigrations(database)).toBe(migrations.length);
  });

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

  test("does not claim an unrelated database or accept a noncontiguous plan", () => {
    using unrelated = new Database(":memory:");
    unrelated.run("CREATE TABLE other_data (id INTEGER)");
    expect(() => applyMigrations(unrelated)).toThrow("unsupported or changed migration history");
    expect(
      unrelated.query("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get(),
    ).toBeNull();
    using empty = new Database(":memory:");
    expect(() => applyMigrations(empty, [{ ...migrations[0]!, version: 2 }])).toThrow(
      "unsupported or changed migration history",
    );
  });
});
