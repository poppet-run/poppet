export const changeAwareMonitoring = `
  ALTER TABLE jobs ADD COLUMN monitor INTEGER NOT NULL DEFAULT 0 CHECK (monitor IN (0, 1));
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
  CREATE INDEX latest_monitor_result ON job_monitor_results (job_id, id DESC);
`;
