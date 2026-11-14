import { SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Effect, Schema } from "effect";
import { Migrator, SqlClient } from "effect/sql";

import { StoreError } from "#src/errors";
import { baseline } from "#src/migrations/0001_baseline";
import { sessionActiveRun } from "#src/migrations/0002_session_active_run";
import { attachments } from "#src/migrations/0003_attachments";
import { removeWorkload } from "#src/migrations/0004_remove_workload";
import { decodeRow } from "#src/sql";

export interface PackageSchema {
  readonly table: string;
  readonly version: number;
  readonly loader: Migrator.Loader;
}

export const migrationStatements = (statements: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    for (const statement of statements) yield* sql.unsafe(statement);
  });

export const packageSchema = (
  table: string,
  migrations: Record<string, ReadonlyArray<string>>,
): PackageSchema => ({
  table,
  version: Math.max(...Object.keys(migrations).map((key) => Number.parseInt(key, 10))),
  loader: Migrator.fromRecord(
    Object.fromEntries(
      Object.entries(migrations).map(([key, statements]) => [key, migrationStatements(statements)]),
    ),
  ),
});

export const storeSchema = packageSchema("effect_sql_migrations", {
  "1_baseline": baseline,
  "2_session_active_run": sessionActiveRun,
  "3_attachments": attachments,
  "4_remove_workload": removeWorkload,
});

const migrationFailure = (message: string) => new StoreError({ reason: "migration", message });

export const migrate = (schema: PackageSchema) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const ledger = yield* sql`SELECT name FROM sqlite_master WHERE name = ${schema.table}`;

    if (ledger.length > 0) {
      const latest = yield* sql`SELECT MAX(migration_id) AS latest FROM ${sql(schema.table)}`.pipe(
        decodeRow(Schema.Struct({ latest: Schema.NullOr(Schema.Int) })),
      );

      if ((latest?.latest ?? 0) > schema.version)
        return yield* migrationFailure(
          "The conversation database was created by a newer version of Poppet. Upgrade Poppet to open it.",
        );
    }

    yield* SqliteMigrator.run({ loader: schema.loader, table: schema.table });
  }).pipe(
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.mapError((error) =>
      error instanceof StoreError
        ? error
        : migrationFailure(
            "Conversation database migration failed. No pending migrations were committed.",
          ),
    ),
  );
