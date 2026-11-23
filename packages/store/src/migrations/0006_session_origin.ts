export const sessionOrigin: ReadonlyArray<string> = [
  "ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'chat'",
  "UPDATE sessions SET origin = 'scheduled' WHERE title_source = 'task'",
  "CREATE INDEX sessions_by_origin ON sessions (origin, updated_at DESC, created_at, id)",
];
