export const sessionActiveRun: ReadonlyArray<string> = [
  `DROP INDEX one_active_run`,
  `CREATE UNIQUE INDEX one_active_run_per_session ON runs (session_id)
    WHERE status IN ('pending', 'running')`,
];
