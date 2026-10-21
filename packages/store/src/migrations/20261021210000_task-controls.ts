export const taskControls = `
  ALTER TABLE jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
  ALTER TABLE jobs ADD COLUMN monitor_revision INTEGER NOT NULL DEFAULT 0 CHECK (monitor_revision >= 0);
  ALTER TABLE jobs ADD COLUMN monitor_baseline_after INTEGER NOT NULL DEFAULT 0 CHECK (monitor_baseline_after >= 0);

  CREATE TABLE job_occurrences_new (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs (id),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    definition TEXT NOT NULL CHECK (json_valid(definition)),
    scheduled_at INTEGER NOT NULL CHECK (scheduled_at >= 0),
    available_at INTEGER NOT NULL CHECK (available_at >= 0),
    origin TEXT NOT NULL DEFAULT 'scheduled' CHECK (origin IN ('scheduled', 'manual')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'interrupted', 'cancelled', 'expired')),
    session_id TEXT REFERENCES sessions (id), run_id TEXT REFERENCES runs (id),
    finished_at INTEGER, reason TEXT,
    destination TEXT CHECK (destination IS NULL OR json_valid(destination)),
    UNIQUE (job_id, revision, scheduled_at)
  ) STRICT;
  INSERT INTO job_occurrences_new
    (id, job_id, revision, definition, scheduled_at, available_at, status, session_id, run_id, finished_at, reason, destination)
    SELECT o.id, o.job_id, 0,
      json_object('name', j.name, 'prompt', j.prompt, 'provider', j.provider, 'model', j.model,
        'workload', j.workload, 'schedule', json(j.schedule), 'skill', json(j.skill),
        'monitor', json(CASE j.monitor WHEN 1 THEN 'true' ELSE 'false' END)),
      o.scheduled_at, o.scheduled_at, o.status, o.session_id, o.run_id, o.finished_at, o.reason, o.destination
    FROM job_occurrences o JOIN jobs j ON j.id = o.job_id;

  -- Copy the child first: dropping its parent with foreign keys enabled would cascade results.
  CREATE TEMP TABLE saved_monitor_results AS SELECT * FROM job_monitor_results;
  DROP TABLE job_monitor_results;
  DROP TABLE job_occurrences;
  ALTER TABLE job_occurrences_new RENAME TO job_occurrences;
  CREATE UNIQUE INDEX one_pending_job_occurrence ON job_occurrences (job_id) WHERE status IN ('pending', 'running');
  CREATE INDEX pending_job_occurrences ON job_occurrences (status, available_at, scheduled_at);
  CREATE TABLE job_monitor_results (
    id INTEGER PRIMARY KEY,
    occurrence_id TEXT NOT NULL UNIQUE REFERENCES job_occurrences (id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    value TEXT NOT NULL CHECK (length(CAST(value AS BLOB)) BETWEEN 1 AND 1024),
    summary TEXT NOT NULL CHECK (length(CAST(summary AS BLOB)) BETWEEN 1 AND 2048),
    sources TEXT NOT NULL CHECK (json_valid(sources)),
    observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
    previous_value TEXT CHECK (previous_value IS NULL OR length(CAST(previous_value AS BLOB)) BETWEEN 1 AND 1024),
    decision TEXT NOT NULL CHECK (decision IN ('baseline', 'unchanged', 'changed')),
    notification_text TEXT CHECK (notification_text IS NULL OR length(CAST(notification_text AS BLOB)) BETWEEN 1 AND 16384),
    CHECK ((decision = 'baseline') = (previous_value IS NULL)),
    CHECK ((decision = 'changed') = (notification_text IS NOT NULL)),
    CHECK (decision != 'unchanged' OR value = previous_value),
    CHECK (decision != 'changed' OR value != previous_value)
  ) STRICT;
  INSERT INTO job_monitor_results SELECT * FROM saved_monitor_results;
  DROP TABLE saved_monitor_results;
  CREATE INDEX latest_monitor_result ON job_monitor_results (job_id, id DESC);

  CREATE TABLE job_operations (
    operation_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    command TEXT NOT NULL CHECK (json_valid(command)),
    receipt TEXT NOT NULL CHECK (json_valid(receipt)),
    changes TEXT CHECK (changes IS NULL OR json_valid(changes)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0)
  ) STRICT;
  CREATE INDEX task_change_history ON job_operations (job_id, created_at DESC);
`;
