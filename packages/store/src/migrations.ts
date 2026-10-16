import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { Schema } from "effect";

import { StoreError } from "#src/errors";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const applicationId = 0x504f5054;

export const migrations: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: "conversation-records",
    sql: `
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      UNIQUE (id, provider, model)
    ) STRICT;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'interrupted')),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      started_at INTEGER, finished_at INTEGER, result TEXT, failure_reason TEXT,
      UNIQUE (session_id, id),
      FOREIGN KEY (session_id, provider, model) REFERENCES sessions (id, provider, model),
      CHECK (started_at IS NULL OR started_at >= created_at),
      CHECK (finished_at IS NULL OR finished_at >= created_at),
      CHECK (
        (status = 'pending' AND started_at IS NULL AND finished_at IS NULL AND result IS NULL AND failure_reason IS NULL) OR
        (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL AND result IS NULL AND failure_reason IS NULL) OR
        (status = 'completed' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND result IS NOT NULL AND failure_reason IS NULL) OR
        (status IN ('failed', 'interrupted') AND finished_at IS NOT NULL AND result IS NULL AND failure_reason IS NOT NULL)
      )
    ) STRICT;
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions (id), run_id TEXT,
      position INTEGER NOT NULL CHECK (position >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0), payload TEXT NOT NULL,
      UNIQUE (session_id, position),
      FOREIGN KEY (session_id, run_id) REFERENCES runs (session_id, id)
    ) STRICT;
  `,
  },
  {
    version: 2,
    name: "run-ownership-and-history-indexes",
    sql: `
    CREATE UNIQUE INDEX one_active_run ON runs ((1)) WHERE status IN ('pending', 'running');
    CREATE INDEX runs_by_session ON runs (session_id, created_at, id);
    CREATE INDEX messages_by_run ON messages (run_id);
  `,
  },
  {
    version: 3,
    name: "session-and-run-workload",
    sql: `
    ALTER TABLE sessions ADD COLUMN workload TEXT NOT NULL DEFAULT 'assistant' CHECK (workload IN ('assistant', 'coding'));
    ALTER TABLE runs ADD COLUMN workload TEXT NOT NULL DEFAULT 'assistant' CHECK (workload IN ('assistant', 'coding'));
  `,
  },
  {
    version: 4,
    name: "durable-tool-calls",
    sql: `
    CREATE TABLE tool_calls (
      run_id TEXT NOT NULL REFERENCES runs (id), call_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0), name TEXT NOT NULL, namespace TEXT,
      arguments TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'interrupted', 'uncertain')),
      created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, output TEXT, failure_reason TEXT,
      PRIMARY KEY (run_id, call_id), UNIQUE (run_id, position),
      CHECK (created_at >= 0), CHECK (started_at IS NULL OR started_at >= created_at),
      CHECK (finished_at IS NULL OR finished_at >= created_at),
      CHECK (
        (status = 'pending' AND started_at IS NULL AND finished_at IS NULL AND output IS NULL AND failure_reason IS NULL) OR
        (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL AND output IS NULL AND failure_reason IS NULL) OR
        (status = 'completed' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND output IS NOT NULL AND failure_reason IS NULL) OR
        (status IN ('failed', 'interrupted', 'uncertain') AND finished_at IS NOT NULL AND output IS NULL AND failure_reason IS NOT NULL)
      )
    ) STRICT;
  `,
  },
  {
    version: 5,
    name: "explicit-memory",
    sql: `
    CREATE TABLE memories (
      key TEXT PRIMARY KEY NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
      value TEXT NOT NULL CHECK (length(CAST(value AS BLOB)) BETWEEN 1 AND 4096),
      source_run_id TEXT REFERENCES runs (id),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    ) STRICT;
  `,
  },
  {
    version: 6,
    name: "scheduled-tasks",
    sql: `
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL,
      workload TEXT NOT NULL CHECK (workload IN ('assistant', 'coding')),
      schedule TEXT NOT NULL, next_at INTEGER,
      paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
      created_at INTEGER NOT NULL CHECK (created_at >= 0)
    ) STRICT;
    CREATE TABLE job_occurrences (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs (id),
      scheduled_at INTEGER NOT NULL CHECK (scheduled_at >= 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'interrupted', 'cancelled', 'expired')),
      session_id TEXT REFERENCES sessions (id), run_id TEXT REFERENCES runs (id),
      finished_at INTEGER, reason TEXT,
      UNIQUE (job_id, scheduled_at)
    ) STRICT;
    CREATE UNIQUE INDEX one_pending_job_occurrence ON job_occurrences (job_id) WHERE status IN ('pending', 'running');
    CREATE INDEX pending_job_occurrences ON job_occurrences (status, scheduled_at);
    CREATE TABLE job_skips (
      id INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs (id),
      first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, reason TEXT NOT NULL
    ) STRICT;
    CREATE TABLE job_provider_pauses (
      provider TEXT PRIMARY KEY, reason TEXT NOT NULL CHECK (reason IN ('quota', 'temporary', 'rate-limit')),
      resume_at INTEGER, failures INTEGER NOT NULL CHECK (failures > 0)
    ) STRICT;
  `,
  },
  {
    version: 7,
    name: "messaging-gateway",
    sql: `
    CREATE TABLE gateway_bindings (
      adapter TEXT NOT NULL, account TEXT NOT NULL, scope_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions (id),
      PRIMARY KEY (adapter, account, scope_id, conversation_id)
    ) STRICT;
    CREATE TABLE gateway_inbox (
      id INTEGER PRIMARY KEY, adapter TEXT NOT NULL, account TEXT NOT NULL,
      external_id TEXT NOT NULL, payload TEXT NOT NULL, conversation_id TEXT,
      session_id TEXT REFERENCES sessions (id), run_id TEXT NOT NULL UNIQUE,
      attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK (state IN ('queued', 'executing', 'completed', 'failed', 'cancelled')),
      UNIQUE (adapter, account, external_id)
    ) STRICT;
    CREATE INDEX queued_gateway_messages ON gateway_inbox (adapter, account, state, id);
    CREATE TABLE gateway_deliveries (
      inbox_id INTEGER NOT NULL REFERENCES gateway_inbox (id), position INTEGER NOT NULL,
      text TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'uncertain')),
      message_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (inbox_id, position)
    ) STRICT;
  `,
  },
  {
    version: 8,
    name: "session-titles",
    sql: `
    ALTER TABLE sessions ADD COLUMN title TEXT;
    ALTER TABLE sessions ADD COLUMN title_source TEXT CHECK (title_source IN ('fallback', 'generated', 'manual', 'task'));
    ALTER TABLE sessions ADD COLUMN title_attempted INTEGER NOT NULL DEFAULT 0 CHECK (title_attempted IN (0, 1));
    ALTER TABLE sessions ADD COLUMN title_usage TEXT;
    ALTER TABLE gateway_bindings ADD COLUMN managed_name TEXT;
    ALTER TABLE gateway_bindings ADD COLUMN pending_name TEXT;
    ALTER TABLE gateway_bindings ADD COLUMN synced_title TEXT;
    ALTER TABLE gateway_bindings ADD COLUMN naming_disabled INTEGER NOT NULL DEFAULT 0 CHECK (naming_disabled IN (0, 1));
    ALTER TABLE gateway_bindings ADD COLUMN creation_message_id TEXT;
    `,
  },
  {
    version: 9,
    name: "conversation-search",
    sql: `
    CREATE VIEW searchable_messages AS
    SELECT m.id, m.run_id,
      CASE json_extract(m.payload, '$.role')
        WHEN 'user' THEN json_extract(m.payload, '$.text')
        ELSE (SELECT group_concat(json_extract(part.value, '$.text'), char(10))
          FROM json_each(m.payload, '$.output') AS part
          WHERE json_extract(part.value, '$.type') = 'text')
      END AS text
    FROM messages AS m JOIN runs AS r ON r.id = m.run_id
    WHERE r.status = 'completed' AND (
      json_extract(m.payload, '$.role') = 'user' OR (
        json_extract(m.payload, '$.role') = 'assistant' AND
        m.position = (SELECT MAX(last.position) FROM messages AS last WHERE last.run_id = r.id)
      )
    );
    CREATE VIRTUAL TABLE session_search USING fts5(text);
    INSERT INTO session_search (rowid, text) SELECT id, text FROM searchable_messages WHERE text IS NOT NULL;
    CREATE TRIGGER index_completed_run AFTER UPDATE OF status ON runs
    WHEN NEW.status = 'completed' AND OLD.status != 'completed'
    BEGIN
      INSERT INTO session_search (rowid, text)
        SELECT id, text FROM searchable_messages WHERE run_id = NEW.id AND text IS NOT NULL;
    END;
    `,
  },
  {
    version: 10,
    name: "local-skill-snapshots",
    sql: `
    ALTER TABLE sessions ADD COLUMN skill TEXT CHECK (skill IS NULL OR json_valid(skill));
    ALTER TABLE jobs ADD COLUMN skill TEXT CHECK (skill IS NULL OR json_valid(skill));
    `,
  },
  {
    version: 11,
    name: "scheduled-result-delivery",
    sql: `
    ALTER TABLE jobs ADD COLUMN destination TEXT CHECK (destination IS NULL OR json_valid(destination));
    ALTER TABLE job_occurrences ADD COLUMN destination TEXT CHECK (destination IS NULL OR json_valid(destination));
    ALTER TABLE gateway_inbox ADD COLUMN occurrence_id TEXT;
    CREATE UNIQUE INDEX scheduled_gateway_result ON gateway_inbox (occurrence_id) WHERE occurrence_id IS NOT NULL;
    `,
  },
];

const Version = Schema.Struct({ user_version: Schema.Natural });

const Application = Schema.Struct({ application_id: Schema.Natural });

const AppliedMigration = Schema.Struct({
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  name: Schema.NonEmptyString,
  checksum: Schema.NonEmptyString,
});

const checksum = (migration: Migration) =>
  createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
    .digest("hex");

const unsupported = () =>
  new StoreError({
    reason: "migration",
    message: "The conversation database has an unsupported or changed migration history.",
  });

// All pending migrations and their ledger entries commit together. A failed step
// leaves both the previous schema and its version unchanged.
export const applyMigrations = (
  database: Database,
  plan: ReadonlyArray<Migration> = migrations,
  at = Date.now(),
) => {
  try {
    for (const [index, migration] of plan.entries()) {
      if (migration.version !== index + 1 || !migration.name || !migration.sql) throw unsupported();
    }

    const current = Schema.decodeUnknownSync(Version)(
      database.query("PRAGMA user_version").get(),
    ).user_version;

    const identity = Schema.decodeUnknownSync(Application)(
      database.query("PRAGMA application_id").get(),
    ).application_id;

    const tables = database
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all();

    if (
      current > plan.length ||
      (identity !== applicationId && (identity !== 0 || tables.length > 0 || current !== 0))
    )
      throw unsupported();

    return database
      .transaction(() => {
        database.run(
          `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT`,
        );

        const applied = Schema.decodeUnknownSync(Schema.Array(AppliedMigration))(
          database
            .query("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
            .all(),
        );

        if (applied.length !== current) throw unsupported();

        for (const [index, entry] of applied.entries()) {
          const migration = plan[index];

          if (
            !migration ||
            entry.version !== migration.version ||
            entry.name !== migration.name ||
            entry.checksum !== checksum(migration)
          )
            throw unsupported();
        }

        for (const migration of plan.slice(current)) {
          database.run(migration.sql);
          database
            .query("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)")
            .run(migration.version, migration.name, checksum(migration), at);
          database.run(`PRAGMA user_version = ${migration.version}`);
        }

        database.run(`PRAGMA application_id = ${applicationId}`);

        return plan.length;
      })
      .immediate();
  } catch (cause) {
    if (cause instanceof StoreError) throw cause;
    throw new StoreError({
      reason: "migration",
      message: "Conversation database migration failed. No pending migrations were committed.",
    });
  }
};
