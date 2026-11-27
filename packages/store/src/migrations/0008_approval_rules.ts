export const approvalRules: ReadonlyArray<string> = [
  `CREATE TABLE approval_rules (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('bash', 'mcp')),
    match_digest TEXT NOT NULL,
    matcher TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    source_approval_id TEXT,
    expires_at INTEGER CHECK (expires_at IS NULL OR expires_at > created_at),
    revoked_at INTEGER,
    last_used_at INTEGER,
    use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0)
  ) STRICT`,

  `CREATE UNIQUE INDEX active_approval_rule_match ON approval_rules (match_digest)
    WHERE revoked_at IS NULL`,

  `CREATE INDEX approval_rules_by_active ON approval_rules (created_at, id)
    WHERE revoked_at IS NULL`,
];
