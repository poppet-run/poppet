// Attachment bytes live in the database so backup, recovery, and file permissions cover them.
export const attachments: ReadonlyArray<string> = [
  `CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id),
    name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size = length(body)),
    created_at INTEGER NOT NULL,
    body BLOB NOT NULL
  ) STRICT`,

  `CREATE INDEX attachments_by_session ON attachments (session_id)`,
];
