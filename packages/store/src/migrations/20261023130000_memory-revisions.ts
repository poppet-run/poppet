export const memoryRevisions = `
  ALTER TABLE memories ADD COLUMN origin TEXT NOT NULL DEFAULT 'cli'
    CHECK (origin IN ('cli', 'turn', 'review'));

  UPDATE memories SET origin = 'turn' WHERE source_run_id IS NOT NULL;

  CREATE TABLE memory_revisions (
    project TEXT NOT NULL DEFAULT '',
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    action TEXT NOT NULL CHECK (action IN ('remember', 'replace', 'forget', 'revert')),
    value TEXT CHECK (value IS NULL OR length(CAST(value AS BLOB)) BETWEEN 1 AND 4096),
    origin TEXT NOT NULL CHECK (origin IN ('cli', 'turn', 'review')),
    source_run_id TEXT REFERENCES runs (id),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (project, key, revision),
    CHECK ((action = 'forget') = (value IS NULL)),
    CHECK ((origin = 'cli') = (source_run_id IS NULL))
  ) STRICT;

  INSERT INTO memory_revisions (project, key, revision, action, value, origin, source_run_id, created_at)
    SELECT project, key, 1, 'remember', value, origin, source_run_id, updated_at
    FROM memories;
`;
