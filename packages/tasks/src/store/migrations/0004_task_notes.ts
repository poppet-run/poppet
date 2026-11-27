export const taskNotes: ReadonlyArray<string> = [
  `CREATE TABLE job_notes (
    id INTEGER PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    text TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('occurrence', 'cli')),
    occurrence_id TEXT,
    run_id TEXT REFERENCES runs (id),
    created_at INTEGER NOT NULL,
    CHECK ((origin = 'cli') = (occurrence_id IS NULL AND run_id IS NULL))
  ) STRICT`,

  "CREATE INDEX job_notes_by_job ON job_notes (job_id, id)",
];
