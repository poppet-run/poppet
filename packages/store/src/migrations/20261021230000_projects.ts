export const projects = `
  ALTER TABLE sessions ADD COLUMN project TEXT CHECK (project IS NULL OR json_valid(project));

  ALTER TABLE jobs ADD COLUMN project TEXT CHECK (project IS NULL OR json_valid(project));

  UPDATE job_occurrences SET definition = json_set(definition, '$.project', NULL);

  CREATE TABLE scoped_memories (
    project TEXT NOT NULL DEFAULT '',
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
    value TEXT NOT NULL CHECK (length(CAST(value AS BLOB)) BETWEEN 1 AND 4096),
    source_run_id TEXT REFERENCES runs(id),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    PRIMARY KEY (project, key)
  ) STRICT;

  INSERT INTO scoped_memories
    SELECT '', key, value, source_run_id, updated_at
    FROM memories;

  DROP TABLE memories;

  ALTER TABLE scoped_memories RENAME TO memories;

  CREATE INDEX sessions_by_project ON sessions (json_extract(project, '$.name'));
`;
