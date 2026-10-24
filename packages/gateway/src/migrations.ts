import { migrationStatements } from "@poppet/store";
import { Migrator } from "effect/sql";

// Messaging channels: inbox, bindings, and deliveries. Each statement runs separately; append new migrations, never edit applied ones.
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

/** Migrations for this package's tables, recorded in their own ledger. */
export const gatewaySchema = {
  table: "gateway_migrations",
  version: 1,
  loader: Migrator.fromRecord({ "1_baseline": migrationStatements(baseline) }),
};
