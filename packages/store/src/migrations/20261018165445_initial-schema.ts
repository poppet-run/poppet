export const initialSchema = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    workload TEXT NOT NULL DEFAULT 'assistant' CHECK (workload IN ('assistant', 'coding')),
    title TEXT,
    title_source TEXT CHECK (title_source IN ('fallback', 'generated', 'manual', 'task')),
    title_attempted INTEGER NOT NULL DEFAULT 0 CHECK (title_attempted IN (0, 1)),
    title_usage TEXT,
    skill TEXT CHECK (skill IS NULL OR json_valid(skill)),
    UNIQUE (id, provider, model)
  ) STRICT;

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL
      CHECK (status IN ('pending', 'running', 'completed', 'failed', 'interrupted')),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    started_at INTEGER,
    finished_at INTEGER,
    result TEXT,
    failure_reason TEXT,
    workload TEXT NOT NULL DEFAULT 'assistant' CHECK (workload IN ('assistant', 'coding')),
    UNIQUE (session_id, id),
    FOREIGN KEY (session_id, provider, model) REFERENCES sessions (id, provider, model),
    CHECK (started_at IS NULL OR started_at >= created_at),
    CHECK (finished_at IS NULL OR finished_at >= created_at),
    CHECK (
      (
        status = 'pending'
        AND started_at IS NULL
        AND finished_at IS NULL
        AND result IS NULL
        AND failure_reason IS NULL
      )
      OR (
        status = 'running'
        AND started_at IS NOT NULL
        AND finished_at IS NULL
        AND result IS NULL
        AND failure_reason IS NULL
      )
      OR (
        status = 'completed'
        AND started_at IS NOT NULL
        AND finished_at IS NOT NULL
        AND result IS NOT NULL
        AND failure_reason IS NULL
      )
      OR (
        status IN ('failed', 'interrupted')
        AND finished_at IS NOT NULL
        AND result IS NULL
        AND failure_reason IS NOT NULL
      )
    )
  ) STRICT;

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id),
    run_id TEXT,
    position INTEGER NOT NULL CHECK (position >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    payload TEXT NOT NULL,
    UNIQUE (session_id, position),
    FOREIGN KEY (session_id, run_id) REFERENCES runs (session_id, id)
  ) STRICT;

  CREATE UNIQUE INDEX one_active_run ON runs ((1)) WHERE status IN ('pending', 'running');

  CREATE INDEX runs_by_session ON runs (session_id, created_at, id);

  CREATE INDEX messages_by_run ON messages (run_id);

  CREATE TABLE tool_calls (
    run_id TEXT NOT NULL REFERENCES runs (id),
    call_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    name TEXT NOT NULL,
    namespace TEXT,
    arguments TEXT NOT NULL,
    status TEXT NOT NULL
      CHECK (status IN ('pending', 'running', 'completed', 'failed', 'interrupted', 'uncertain')),
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    output TEXT,
    failure_reason TEXT,
    server_id TEXT,
    tool_name TEXT CHECK ((server_id IS NULL) = (tool_name IS NULL)),
    PRIMARY KEY (run_id, call_id),
    UNIQUE (run_id, position),
    CHECK (created_at >= 0),
    CHECK (started_at IS NULL OR started_at >= created_at),
    CHECK (finished_at IS NULL OR finished_at >= created_at),
    CHECK (
      (
        status = 'pending'
        AND started_at IS NULL
        AND finished_at IS NULL
        AND output IS NULL
        AND failure_reason IS NULL
      )
      OR (
        status = 'running'
        AND started_at IS NOT NULL
        AND finished_at IS NULL
        AND output IS NULL
        AND failure_reason IS NULL
      )
      OR (
        status = 'completed'
        AND started_at IS NOT NULL
        AND finished_at IS NOT NULL
        AND output IS NOT NULL
        AND failure_reason IS NULL
      )
      OR (
        status IN ('failed', 'interrupted', 'uncertain')
        AND finished_at IS NOT NULL
        AND output IS NULL
        AND failure_reason IS NOT NULL
      )
    )
  ) STRICT;

  CREATE TABLE memories (
    key TEXT PRIMARY KEY NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
    value TEXT NOT NULL CHECK (length(CAST(value AS BLOB)) BETWEEN 1 AND 4096),
    source_run_id TEXT REFERENCES runs (id),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT;

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    workload TEXT NOT NULL CHECK (workload IN ('assistant', 'coding')),
    schedule TEXT NOT NULL,
    next_at INTEGER,
    paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    skill TEXT CHECK (skill IS NULL OR json_valid(skill)),
    destination TEXT CHECK (destination IS NULL OR json_valid(destination)),
    source_run_id TEXT REFERENCES runs (id),
    source_call_id TEXT CHECK ((source_run_id IS NULL) = (source_call_id IS NULL))
  ) STRICT;

  CREATE UNIQUE INDEX task_source_call
    ON jobs (source_run_id, source_call_id)
    WHERE source_run_id IS NOT NULL;

  CREATE TABLE job_occurrences (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs (id),
    scheduled_at INTEGER NOT NULL CHECK (scheduled_at >= 0),
    status TEXT NOT NULL
      CHECK (status IN (
        'pending', 'running', 'completed', 'failed', 'interrupted', 'cancelled', 'expired'
      )),
    session_id TEXT REFERENCES sessions (id),
    run_id TEXT REFERENCES runs (id),
    finished_at INTEGER,
    reason TEXT,
    destination TEXT CHECK (destination IS NULL OR json_valid(destination)),
    UNIQUE (job_id, scheduled_at)
  ) STRICT;

  CREATE UNIQUE INDEX one_pending_job_occurrence
    ON job_occurrences (job_id)
    WHERE status IN ('pending', 'running');

  CREATE INDEX pending_job_occurrences ON job_occurrences (status, scheduled_at);

  CREATE TABLE job_skips (
    id INTEGER PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs (id),
    first_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    reason TEXT NOT NULL
  ) STRICT;

  CREATE TABLE job_provider_pauses (
    provider TEXT PRIMARY KEY,
    reason TEXT NOT NULL CHECK (reason IN ('quota', 'temporary', 'rate-limit')),
    resume_at INTEGER,
    failures INTEGER NOT NULL CHECK (failures > 0)
  ) STRICT;

  CREATE TABLE gateway_bindings (
    adapter TEXT NOT NULL,
    account TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions (id),
    managed_name TEXT,
    pending_name TEXT,
    synced_title TEXT,
    naming_disabled INTEGER NOT NULL DEFAULT 0 CHECK (naming_disabled IN (0, 1)),
    creation_message_id TEXT,
    PRIMARY KEY (adapter, account, scope_id, conversation_id)
  ) STRICT;

  CREATE TABLE gateway_inbox (
    id INTEGER PRIMARY KEY,
    adapter TEXT NOT NULL,
    account TEXT NOT NULL,
    external_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    conversation_id TEXT,
    session_id TEXT REFERENCES sessions (id),
    run_id TEXT NOT NULL UNIQUE,
    attempts INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL
      CHECK (state IN ('queued', 'executing', 'completed', 'failed', 'cancelled')),
    occurrence_id TEXT,
    UNIQUE (adapter, account, external_id)
  ) STRICT;

  CREATE INDEX queued_gateway_messages ON gateway_inbox (adapter, account, state, id);

  CREATE UNIQUE INDEX scheduled_gateway_result
    ON gateway_inbox (occurrence_id)
    WHERE occurrence_id IS NOT NULL;

  CREATE TABLE gateway_deliveries (
    inbox_id INTEGER NOT NULL REFERENCES gateway_inbox (id),
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'uncertain')),
    message_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (inbox_id, position)
  ) STRICT;

  CREATE TABLE gateway_cursors (
    adapter TEXT NOT NULL,
    account TEXT NOT NULL,
    cursor TEXT NOT NULL,
    PRIMARY KEY (adapter, account)
  ) STRICT;

  CREATE VIEW searchable_messages AS
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
        AND m.position = (
          SELECT MAX(last.position)
          FROM messages AS last
          WHERE last.run_id = r.id
        )
      )
    );

  CREATE VIRTUAL TABLE session_search USING fts5(text);

  CREATE TRIGGER index_completed_run AFTER UPDATE OF status ON runs
  WHEN NEW.status = 'completed' AND OLD.status != 'completed'
  BEGIN
    INSERT INTO session_search (rowid, text)
      SELECT id, text
      FROM searchable_messages
      WHERE run_id = NEW.id AND text IS NOT NULL;
  END;
`;
