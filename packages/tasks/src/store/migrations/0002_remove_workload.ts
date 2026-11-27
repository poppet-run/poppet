export const removeWorkload: ReadonlyArray<string> = [
  "ALTER TABLE jobs DROP COLUMN workload",
  "UPDATE job_occurrences SET definition = json_remove(definition, '$.workload')",
];
