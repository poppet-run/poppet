export const learningReviews = `
  CREATE TABLE learning_reviews (
    id TEXT PRIMARY KEY,
    source_run_id TEXT NOT NULL UNIQUE REFERENCES runs (id),
    session_id TEXT NOT NULL REFERENCES sessions (id),
    state TEXT NOT NULL
      CHECK (state IN ('pending', 'running', 'completed', 'skipped', 'failed', 'uncertain')),
    reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 512),
    summary TEXT CHECK (summary IS NULL OR length(CAST(summary AS BLOB)) <= 4096),
    changes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changes) AND json_type(changes) = 'array'),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    notified_at INTEGER CHECK (notified_at IS NULL OR notified_at >= created_at)
  ) STRICT;

  CREATE INDEX learning_reviews_by_state ON learning_reviews (state, created_at);

  CREATE INDEX learning_reviews_by_session ON learning_reviews (session_id, created_at);
`;
