import { packageSchema } from "@poppet/store";

const baseline: ReadonlyArray<string> = [
  `CREATE TABLE gateway_bindings (
    adapter TEXT NOT NULL,
    account TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions (id),
    managed_name TEXT,
    pending_name TEXT,
    synced_title TEXT,
    naming_disabled INTEGER NOT NULL DEFAULT 0,
    creation_message_id TEXT,
    PRIMARY KEY (adapter, account, scope_id, conversation_id)
  ) STRICT`,

  `CREATE TABLE gateway_inbox (
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
    state TEXT NOT NULL,
    occurrence_id TEXT,
    UNIQUE (adapter, account, external_id)
  ) STRICT`,

  `CREATE INDEX queued_gateway_messages ON gateway_inbox (adapter, account, state, id)`,

  `CREATE UNIQUE INDEX scheduled_gateway_result ON gateway_inbox (occurrence_id, run_id)
    WHERE occurrence_id IS NOT NULL`,

  `CREATE TABLE gateway_deliveries (
    inbox_id INTEGER NOT NULL REFERENCES gateway_inbox (id),
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    state TEXT NOT NULL,
    message_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (inbox_id, position)
  ) STRICT`,
];

const sessionRemoval: ReadonlyArray<string> = [
  `CREATE TRIGGER detach_gateway_sessions BEFORE DELETE ON sessions
  BEGIN
    DELETE FROM gateway_bindings WHERE session_id = OLD.id;
    UPDATE gateway_inbox SET session_id = NULL WHERE session_id = OLD.id;
  END`,
];

export const gatewaySchema = packageSchema("gateway_migrations", {
  "1_baseline": baseline,
  "2_session_removal": sessionRemoval,
  "3_session_origin": [
    `UPDATE sessions SET origin = 'scheduled' WHERE id IN (
      SELECT runs.session_id FROM gateway_inbox JOIN runs ON runs.id = gateway_inbox.run_id
      WHERE occurrence_id IS NOT NULL
    )`,
    `UPDATE sessions SET origin = 'gateway:' || history.adapter FROM (
      SELECT session_id, adapter FROM gateway_bindings
      UNION
      SELECT session_id, adapter FROM gateway_inbox WHERE occurrence_id IS NULL
    ) AS history WHERE sessions.id = history.session_id AND sessions.origin = 'chat'`,
  ],
  "4_approvals": [
    `CREATE TABLE gateway_approvals (
      id TEXT PRIMARY KEY,
      adapter TEXT NOT NULL,
      account TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('bash', 'mcp')),
      message_id TEXT,
      state TEXT NOT NULL CHECK (state IN
        ('pending', 'approved', 'denied', 'expired', 'cancelled', 'unavailable')),
      expires_at INTEGER NOT NULL
    ) STRICT`,

    `CREATE INDEX pending_gateway_approvals ON gateway_approvals (adapter, account)
      WHERE state = 'pending'`,
  ],
});
