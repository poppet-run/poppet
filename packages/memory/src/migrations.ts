import { migrationStatements } from "@poppet/store";
import { Migrator } from "effect/sql";

// Saved facts are an append-only revision history; the memories view shows current values. Each statement runs separately; append new migrations, never edit applied ones.
const baseline: ReadonlyArray<string> = [
  `CREATE TABLE memory_revisions (
    key TEXT NOT NULL,
    revision INTEGER NOT NULL,
    action TEXT NOT NULL,
    value TEXT,
    origin TEXT NOT NULL,
    source_run_id TEXT REFERENCES runs (id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (key, revision),
    CHECK ((action = 'forget') = (value IS NULL)),
    CHECK ((origin = 'cli') = (source_run_id IS NULL))
  ) STRICT`,

  // Current facts: each key's latest revision, unless that revision forgot it.
  `CREATE VIEW memories AS
  SELECT key, value, origin, source_run_id, created_at AS updated_at
  FROM memory_revisions AS latest
  WHERE action != 'forget'
    AND revision = (SELECT MAX(revision) FROM memory_revisions WHERE key = latest.key)`,
];

/** Migrations for this package's tables, recorded in their own ledger. */
export const memorySchema = {
  table: "memory_migrations",
  version: 1,
  loader: Migrator.fromRecord({ "1_baseline": migrationStatements(baseline) }),
};
