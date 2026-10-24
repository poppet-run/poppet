import { migrationStatements } from "@poppet/store";
import { Migrator } from "effect/sql";

// Scheduled tasks. Deleting a task deletes its history. An occurrence snapshots its task definition. Each statement runs separately; append new migrations, never edit applied ones.
const baseline: ReadonlyArray<string> = [
  `CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    workload TEXT NOT NULL CHECK (workload IN ('assistant', 'coding')),
    schedule TEXT NOT NULL CHECK (json_valid(schedule)),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    next_at INTEGER,
    paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    skill TEXT CHECK (skill IS NULL OR json_valid(skill)),
    destination TEXT CHECK (destination IS NULL OR json_valid(destination)),
    source_run_id TEXT REFERENCES runs (id),
    source_call_id TEXT CHECK ((source_run_id IS NULL) = (source_call_id IS NULL))
  ) STRICT`,

  `CREATE UNIQUE INDEX task_source_call ON jobs (source_run_id, source_call_id)
    WHERE source_run_id IS NOT NULL`,

  `CREATE TABLE job_occurrences (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    definition TEXT NOT NULL CHECK (json_valid(definition)),
    scheduled_at INTEGER NOT NULL CHECK (scheduled_at >= 0),
    available_at INTEGER NOT NULL CHECK (available_at >= 0),
    origin TEXT NOT NULL DEFAULT 'scheduled' CHECK (origin IN ('scheduled', 'manual')),
    status TEXT NOT NULL CHECK (status IN (
      'pending', 'running', 'completed', 'failed', 'interrupted', 'cancelled', 'expired'
    )),
    session_id TEXT REFERENCES sessions (id),
    run_id TEXT REFERENCES runs (id),
    finished_at INTEGER,
    reason TEXT,
    destination TEXT CHECK (destination IS NULL OR json_valid(destination)),
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
    reason TEXT NOT NULL CHECK (reason IN ('quota', 'temporary', 'rate-limit')),
    resume_at INTEGER,
    failures INTEGER NOT NULL CHECK (failures > 0)
  ) STRICT`,

  // Owner edits to a task, kept so a repeated operation ID replays its receipt.
  `CREATE TABLE job_operations (
    operation_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    command TEXT NOT NULL CHECK (json_valid(command)),
    receipt TEXT NOT NULL CHECK (json_valid(receipt)),
    changes TEXT CHECK (changes IS NULL OR json_valid(changes)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0)
  ) STRICT`,

  `CREATE INDEX task_change_history ON job_operations (job_id, created_at DESC)`,
];

/** Migrations for this package's tables, recorded in their own ledger. */
export const taskSchema = {
  table: "task_migrations",
  version: 1,
  loader: Migrator.fromRecord({ "1_baseline": migrationStatements(baseline) }),
};
