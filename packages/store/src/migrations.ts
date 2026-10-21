import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { Schema } from "effect";

import { StoreError } from "#src/errors";
import { initialSchema } from "#src/migrations/20261018165445_initial-schema";
import { changeAwareMonitoring } from "#src/migrations/20261021120000_change-aware-monitoring";
import { taskControls } from "#src/migrations/20261021210000_task-controls";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const applicationId = 0x504f5054;

export const migrations: ReadonlyArray<Migration> = [
  { version: 1, name: "initial-schema", sql: initialSchema },
  { version: 2, name: "change-aware-monitoring", sql: changeAwareMonitoring },
  { version: 3, name: "task-controls", sql: taskControls },
];

const Version = Schema.Struct({ user_version: Schema.Natural });

const Application = Schema.Struct({ application_id: Schema.Natural });

const AppliedMigration = Schema.Struct({
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  name: Schema.NonEmptyString,
  checksum: Schema.NonEmptyString,
});

const checksum = (migration: Migration) =>
  createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
    .digest("hex");

const unsupported = () =>
  new StoreError({
    reason: "migration",
    message: "The conversation database has an unsupported or changed migration history.",
  });

// All pending migrations and their ledger entries commit together. A failed step
// leaves both the previous schema and its version unchanged.
export const applyMigrations = (
  database: Database,
  plan: ReadonlyArray<Migration> = migrations,
  at = Date.now(),
) => {
  try {
    for (const [index, migration] of plan.entries()) {
      if (migration.version !== index + 1 || !migration.name || !migration.sql) throw unsupported();
    }

    const current = Schema.decodeUnknownSync(Version)(
      database.query("PRAGMA user_version").get(),
    ).user_version;

    const identity = Schema.decodeUnknownSync(Application)(
      database.query("PRAGMA application_id").get(),
    ).application_id;

    const tables = database
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all();

    if (
      current > plan.length ||
      (identity !== applicationId && (identity !== 0 || tables.length > 0 || current !== 0))
    )
      throw unsupported();

    return database
      .transaction(() => {
        database.run(
          `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT`,
        );

        const applied = Schema.decodeUnknownSync(Schema.Array(AppliedMigration))(
          database
            .query("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
            .all(),
        );

        if (applied.length !== current) throw unsupported();

        for (const [index, entry] of applied.entries()) {
          const migration = plan[index];

          if (
            !migration ||
            entry.version !== migration.version ||
            entry.name !== migration.name ||
            entry.checksum !== checksum(migration)
          )
            throw unsupported();
        }

        for (const migration of plan.slice(current)) {
          database.run(migration.sql);
          database
            .query("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)")
            .run(migration.version, migration.name, checksum(migration), at);
          database.run(`PRAGMA user_version = ${migration.version}`);
        }

        database.run(`PRAGMA application_id = ${applicationId}`);

        return plan.length;
      })
      .immediate();
  } catch (cause) {
    if (cause instanceof StoreError) throw cause;
    throw new StoreError({
      reason: "migration",
      message: "Conversation database migration failed. No pending migrations were committed.",
    });
  }
};
