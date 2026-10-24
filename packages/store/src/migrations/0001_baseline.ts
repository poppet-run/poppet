// The conversation schema. Each statement runs separately because SQLite prepares one at a time.
// Checks guard only state combinations that row decoding cannot see; typed code and row schemas cover values.
// Memory, tasks, and gateway define their own tables in their packages.
export const baseline: ReadonlyArray<string> = [
  `CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    workload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    title TEXT,
    title_source TEXT,
    title_attempted INTEGER NOT NULL DEFAULT 0,
    title_usage TEXT,
    skill TEXT
  ) STRICT`,

  // A run uses its session's fixed provider, model, and workload; reads join them in.
  `CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id),
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    result TEXT,
    failure_reason TEXT,
    UNIQUE (session_id, id),
    CHECK (CASE status
      WHEN 'pending' THEN started_at IS NULL AND finished_at IS NULL
        AND result IS NULL AND failure_reason IS NULL
      WHEN 'running' THEN started_at IS NOT NULL AND finished_at IS NULL
        AND result IS NULL AND failure_reason IS NULL
      WHEN 'completed' THEN started_at IS NOT NULL AND finished_at IS NOT NULL
        AND result IS NOT NULL AND failure_reason IS NULL
      ELSE finished_at IS NOT NULL AND result IS NULL AND failure_reason IS NOT NULL
    END)
  ) STRICT`,

  `CREATE UNIQUE INDEX one_active_run ON runs ((1)) WHERE status IN ('pending', 'running')`,

  `CREATE INDEX runs_by_session ON runs (session_id, created_at, id)`,

  // run_id is null for history saved outside a run.
  `CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id),
    run_id TEXT,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE (session_id, position),
    FOREIGN KEY (session_id, run_id) REFERENCES runs (session_id, id)
  ) STRICT`,

  `CREATE INDEX messages_by_run ON messages (run_id)`,

  // Uncertain means a call was running when its run stopped, so its effects are unknown.
  `CREATE TABLE tool_calls (
    run_id TEXT NOT NULL REFERENCES runs (id),
    call_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    namespace TEXT,
    arguments TEXT NOT NULL,
    server_id TEXT,
    tool_name TEXT CHECK ((server_id IS NULL) = (tool_name IS NULL)),
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    output TEXT,
    failure_reason TEXT,
    PRIMARY KEY (run_id, call_id),
    UNIQUE (run_id, position),
    CHECK (CASE status
      WHEN 'pending' THEN started_at IS NULL AND finished_at IS NULL
        AND output IS NULL AND failure_reason IS NULL
      WHEN 'running' THEN started_at IS NOT NULL AND finished_at IS NULL
        AND output IS NULL AND failure_reason IS NULL
      WHEN 'completed' THEN started_at IS NOT NULL AND finished_at IS NOT NULL
        AND output IS NOT NULL AND failure_reason IS NULL
      ELSE finished_at IS NOT NULL AND output IS NULL AND failure_reason IS NOT NULL
    END)
  ) STRICT`,

  // Search covers user messages and each completed run's final answer.
  `CREATE VIEW searchable_messages AS
  SELECT
    m.id,
    m.run_id,
    CASE json_extract(m.payload, '$.role')
      WHEN 'user' THEN json_extract(m.payload, '$.text')
      ELSE (
        SELECT group_concat(json_extract(part.value, '$.text'), char(10))
        FROM json_each(m.payload, '$.output') AS part
        WHERE json_extract(part.value, '$.type') = 'text'
      )
    END AS text
  FROM messages AS m
  JOIN runs AS r ON r.id = m.run_id
  WHERE r.status = 'completed'
    AND (
      json_extract(m.payload, '$.role') = 'user'
      OR (
        json_extract(m.payload, '$.role') = 'assistant'
        AND m.position = (SELECT MAX(last.position) FROM messages AS last WHERE last.run_id = r.id)
      )
    )`,

  `CREATE VIRTUAL TABLE session_search USING fts5(text)`,

  `CREATE TRIGGER index_completed_run AFTER UPDATE OF status ON runs
  WHEN NEW.status = 'completed' AND OLD.status != 'completed'
  BEGIN
    INSERT INTO session_search (rowid, text)
      SELECT id, text FROM searchable_messages WHERE run_id = NEW.id AND text IS NOT NULL;
  END`,
];
