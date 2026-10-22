export const commands = `
  CREATE TABLE command_run_grants (
    run_id TEXT PRIMARY KEY REFERENCES runs(id),
    payload TEXT NOT NULL CHECK (json_valid(payload))
  ) STRICT;
  CREATE TRIGGER immutable_command_grants BEFORE UPDATE ON command_run_grants
    BEGIN SELECT RAISE(ABORT, 'Command grants are immutable'); END;
  ALTER TABLE jobs ADD COLUMN proposal_command TEXT CHECK (proposal_command IS NULL OR json_valid(proposal_command));
  UPDATE job_occurrences SET definition = json_set(definition, '$.proposalCommand', NULL);
`;
