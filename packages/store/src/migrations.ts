import { Effect } from "effect";
import { Migrator, SqlClient } from "effect/sql";

import { baseline } from "#src/migrations/0001_baseline";

const statements = (sql: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient;

    for (const statement of sql) yield* client.unsafe(statement);
  });

/**
 * Append a new `<id>_<name>` entry for each schema change; never edit an applied one.
 * The migrator runs all pending entries in one transaction.
 */
export const migrations = Migrator.fromRecord({
  "1_baseline": statements(baseline),
});

/** The highest migration ID this build knows. */
export const schemaVersion = 1;
