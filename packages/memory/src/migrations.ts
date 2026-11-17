import { packageSchema } from "@poppet/store";

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

  `CREATE VIEW memories AS
  SELECT key, value, origin, source_run_id, created_at AS updated_at
  FROM memory_revisions AS latest
  WHERE action != 'forget'
    AND revision = (SELECT MAX(revision) FROM memory_revisions WHERE key = latest.key)`,
];

const sessionRemoval: ReadonlyArray<string> = [
  "DROP VIEW memories",

  `CREATE TABLE memory_revisions_next (
    key TEXT NOT NULL,
    revision INTEGER NOT NULL,
    action TEXT NOT NULL,
    value TEXT,
    origin TEXT NOT NULL,
    source_run_id TEXT REFERENCES runs (id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (key, revision),
    CHECK ((action = 'forget') = (value IS NULL)),
    CHECK (origin != 'cli' OR source_run_id IS NULL)
  ) STRICT`,

  "INSERT INTO memory_revisions_next SELECT * FROM memory_revisions",

  "DROP TABLE memory_revisions",

  "ALTER TABLE memory_revisions_next RENAME TO memory_revisions",

  `CREATE VIEW memories AS
  SELECT key, value, origin, source_run_id, created_at AS updated_at
  FROM memory_revisions AS latest
  WHERE action != 'forget'
    AND revision = (SELECT MAX(revision) FROM memory_revisions WHERE key = latest.key)`,

  `CREATE TRIGGER detach_memory_runs BEFORE DELETE ON runs
  BEGIN
    UPDATE memory_revisions SET source_run_id = NULL WHERE source_run_id = OLD.id;
  END`,
];

export const memoryMigrations = { "1_baseline": baseline, "2_session_removal": sessionRemoval };

export const memorySchema = packageSchema("memory_migrations", memoryMigrations);
