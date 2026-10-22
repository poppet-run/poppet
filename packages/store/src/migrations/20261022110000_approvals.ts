export const approvals = `
  ALTER TABLE jobs ADD COLUMN proposal_note TEXT;
  UPDATE job_occurrences SET definition = json_set(definition, '$.proposalNote', NULL);
  CREATE TABLE action_proposals (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    digest TEXT NOT NULL,
    source_session_id TEXT NOT NULL REFERENCES sessions(id),
    source_run_id TEXT NOT NULL REFERENCES runs(id),
    source_call_id TEXT NOT NULL,
    job_id TEXT,
    revision INTEGER,
    occurrence_id TEXT UNIQUE,
    destination TEXT CHECK (destination IS NULL OR json_valid(destination)),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'executing', 'completed', 'failed', 'cancelled', 'expired', 'uncertain')),
    receipt TEXT CHECK (receipt IS NULL OR json_valid(receipt)),
    UNIQUE (source_run_id, source_call_id)
  ) STRICT;
  CREATE TRIGGER immutable_action_proposals BEFORE UPDATE OF
    id, owner, payload, digest, source_session_id, source_run_id, source_call_id,
    job_id, revision, occurrence_id, destination, created_at, expires_at
    ON action_proposals BEGIN SELECT RAISE(ABORT, 'Proposal payloads are immutable'); END;
  CREATE INDEX pending_action_proposals ON action_proposals (owner, state, created_at);
  ALTER TABLE gateway_inbox ADD COLUMN proposal_id TEXT;
  CREATE UNIQUE INDEX gateway_proposal_notification ON gateway_inbox(proposal_id) WHERE proposal_id IS NOT NULL;
`;
