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

export const memorySchema = packageSchema("memory_migrations", { "1_baseline": baseline });
