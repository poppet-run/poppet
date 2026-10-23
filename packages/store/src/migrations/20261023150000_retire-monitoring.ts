export const retireMonitoring = `
  UPDATE jobs SET paused = 1, next_at = NULL WHERE monitor = 1;

  UPDATE job_occurrences
  SET status = CASE WHEN status = 'running' THEN 'interrupted' ELSE 'cancelled' END,
      reason = 'monitoring-removed', finished_at = unixepoch('now') * 1000
  WHERE job_id IN (SELECT id FROM jobs WHERE monitor = 1)
    AND status IN ('pending', 'running');

  UPDATE gateway_deliveries
  SET state = CASE WHEN state = 'sending' THEN 'uncertain' ELSE 'failed' END
  WHERE state IN ('pending', 'sending') AND inbox_id IN (
    SELECT i.id FROM gateway_inbox i
    JOIN job_occurrences o ON o.id = i.occurrence_id
    JOIN jobs j ON j.id = o.job_id WHERE j.monitor = 1
  );
`;
