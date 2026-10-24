import { SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Effect, Schema } from "effect";
import { Migrator, SqlClient } from "effect/sql";

import { StoreError } from "#src/errors";
import { baseline } from "#src/migrations/0001_baseline";
import { decodeRow } from "#src/sql";

/** One package's migrations and the ledger table that records them. */
export interface PackageSchema {
  readonly table: string;
  /** The highest migration ID this build knows. */
  readonly version: number;
  /** Entries keyed `<id>_<name>`; append new ones and never edit an applied one. */
  readonly loader: Migrator.Loader;
}

/** A migration that runs each SQL statement in order; SQLite prepares one at a time. */
export const migrationStatements = (statements: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    for (const statement of statements) yield* sql.unsafe(statement);
  });

export const storeSchema: PackageSchema = {
  table: "effect_sql_migrations",
  version: 1,
  loader: Migrator.fromRecord({ "1_baseline": migrationStatements(baseline) }),
};

const migrationFailure = (message: string) => new StoreError({ reason: "migration", message });

/**
 * Applies a package's pending migrations in one transaction. A ledger newer than this
 * build is refused, so an older Poppet never writes to a schema it does not understand.
 */
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
    // A failed migration is reported as a defect after its transaction rolls back.
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.mapError((error) =>
      error instanceof StoreError
        ? error
        : migrationFailure(
            "Conversation database migration failed. No pending migrations were committed.",
          ),
    ),
  );
