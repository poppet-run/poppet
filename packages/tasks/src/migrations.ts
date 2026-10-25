import { packageSchema } from "@poppet/store";

// Scheduled tasks. Deleting a task deletes its history. An occurrence snapshots its task definition. Each statement runs separately; append new migrations, never edit applied ones.
const baseline: ReadonlyArray<string> = [
  `CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    workload TEXT NOT NULL,
    schedule TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER,
    paused INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    skill TEXT,
    destination TEXT
  ) STRICT`,

  `CREATE TABLE job_occurrences (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    definition TEXT NOT NULL,
    scheduled_at INTEGER NOT NULL,
    available_at INTEGER NOT NULL,
    origin TEXT NOT NULL DEFAULT 'scheduled',
    status TEXT NOT NULL,
    session_id TEXT REFERENCES sessions (id),
    run_id TEXT REFERENCES runs (id),
    finished_at INTEGER,
    reason TEXT,
    destination TEXT,
    UNIQUE (job_id, revision, scheduled_at)
  ) STRICT`,

  `CREATE UNIQUE INDEX one_pending_job_occurrence ON job_occurrences (job_id)
    WHERE status IN ('pending', 'running')`,

  `CREATE INDEX pending_job_occurrences ON job_occurrences (status, available_at, scheduled_at)`,

  `CREATE TABLE job_skips (
    id INTEGER PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    first_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    reason TEXT NOT NULL
  ) STRICT`,

  `CREATE TABLE job_provider_pauses (
    provider TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    resume_at INTEGER,
    failures INTEGER NOT NULL
  ) STRICT`,
];

/** Migrations for this package's tables, recorded in their own ledger. */
export const taskSchema = packageSchema("task_migrations", { "1_baseline": baseline });
