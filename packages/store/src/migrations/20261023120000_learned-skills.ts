export const learnedSkills = `
  CREATE TABLE learned_skills (
    name TEXT PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 128),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) BETWEEN 1 AND 8192),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
  ) STRICT;

  CREATE TABLE skill_revisions (
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    action TEXT NOT NULL CHECK (action IN ('create', 'patch', 'replace', 'delete', 'revert')),
    content TEXT CHECK (content IS NULL OR length(CAST(content AS BLOB)) BETWEEN 1 AND 8192),
    origin TEXT NOT NULL CHECK (origin IN ('owner', 'turn', 'review')),
    source_run_id TEXT REFERENCES runs (id),
    source_call_id TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (name, revision),
    CHECK ((source_run_id IS NULL) = (source_call_id IS NULL)),
    CHECK ((origin = 'owner') = (source_run_id IS NULL)),
    CHECK ((action = 'delete') = (content IS NULL))
  ) STRICT;

  CREATE UNIQUE INDEX skill_revisions_by_source
    ON skill_revisions (source_run_id, source_call_id)
    WHERE source_run_id IS NOT NULL;
`;
