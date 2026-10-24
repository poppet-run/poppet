import { migrationStatements } from "@poppet/store";
import { Migrator } from "effect/sql";

// Saved facts and their revision history. Each statement runs separately; append new migrations, never edit applied ones.
const baseline: ReadonlyArray<string> = [
  `CREATE TABLE memories (
    key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 128),
    value TEXT NOT NULL CHECK (length(CAST(value AS BLOB)) BETWEEN 1 AND 4096),
    origin TEXT NOT NULL CHECK (origin IN ('cli', 'turn', 'review')),
    source_run_id TEXT REFERENCES runs (id),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT`,

  `CREATE TABLE memory_revisions (
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    action TEXT NOT NULL CHECK (action IN ('remember', 'replace', 'forget', 'revert')),
    value TEXT CHECK (value IS NULL OR length(CAST(value AS BLOB)) BETWEEN 1 AND 4096),
    origin TEXT NOT NULL CHECK (origin IN ('cli', 'turn', 'review')),
    source_run_id TEXT REFERENCES runs (id),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (key, revision),
    CHECK ((action = 'forget') = (value IS NULL)),
    CHECK ((origin = 'cli') = (source_run_id IS NULL))
  ) STRICT`,
];

/** Migrations for this package's tables, recorded in their own ledger. */
export const memorySchema = {
  table: "memory_migrations",
  version: 1,
  loader: Migrator.fromRecord({ "1_baseline": migrationStatements(baseline) }),
};
