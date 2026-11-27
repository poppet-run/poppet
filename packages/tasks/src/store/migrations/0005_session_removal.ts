export const sessionRemoval: ReadonlyArray<string> = [
  `CREATE TRIGGER detach_task_runs BEFORE DELETE ON runs
  BEGIN
    UPDATE job_occurrences SET run_id = NULL WHERE run_id = OLD.id;
    UPDATE job_notes SET run_id = NULL WHERE run_id = OLD.id;
  END`,

  `CREATE TRIGGER detach_task_sessions BEFORE DELETE ON sessions
  BEGIN
    UPDATE job_occurrences SET session_id = NULL WHERE session_id = OLD.id;
  END`,
];
