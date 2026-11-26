// A run is waiting while it has a pending approval. Its stored status stays 'running',
// because widening the runs CHECK would need a table rebuild that drops other packages'
// triggers on runs.
export const approvals: ReadonlyArray<string> = [
  `CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('bash', 'mcp')),
    request TEXT NOT NULL,
    digest TEXT NOT NULL,
    requester TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN
      ('pending', 'approved', 'denied', 'expired', 'cancelled', 'superseded')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
    decided_at INTEGER,
    decided_by TEXT,
    UNIQUE (run_id, call_id),
    FOREIGN KEY (run_id, call_id) REFERENCES tool_calls (run_id, call_id),
    CHECK ((state = 'pending') = (decided_at IS NULL)),
    CHECK ((state IN ('approved', 'denied')) = (decided_by IS NOT NULL))
  ) STRICT`,

  `CREATE UNIQUE INDEX one_pending_approval_per_run ON approvals (run_id)
    WHERE state = 'pending'`,

  `CREATE INDEX pending_approvals_by_expiry ON approvals (expires_at) WHERE state = 'pending'`,
];
