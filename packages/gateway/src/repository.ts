import { randomUUID } from "node:crypto";

import { StoreDatabase, StoreError } from "@poppet/store";
import { Context, Effect, Layer, Schema } from "effect";

import { IncomingMessage, ChannelError } from "#src/channel";

const Inbox = Schema.Struct({
  id: Schema.Natural,
  adapter: Schema.String,
  account: Schema.String,
  message: Schema.fromJsonString(IncomingMessage),
  conversationId: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  runId: Schema.String,
  state: Schema.String,
  attempts: Schema.Natural,
});

export type Inbox = typeof Inbox.Type;

const Delivery = Schema.Struct({
  inboxId: Schema.Natural,
  position: Schema.Natural,
  text: Schema.String,
  attempts: Schema.Natural,
});

export type Delivery = typeof Delivery.Type;

const inboxSql = `SELECT id, adapter, account, payload AS message, conversation_id AS conversationId,
  session_id AS sessionId, run_id AS runId, state, attempts FROM gateway_inbox`;

const Binding = Schema.Struct({ sessionId: Schema.String });

export const gatewayStorage = <A>(operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (cause) =>
      cause instanceof ChannelError
        ? cause
        : new StoreError({ reason: "storage", message: "Cannot read or write messaging records." }),
  });

const repository = Effect.gen(function* () {
  const { database } = yield* StoreDatabase;

  const item = (id: number) =>
    Schema.decodeUnknownSync(Inbox)(database.query(`${inboxSql} WHERE id = ?`).get(id));

  const binding = (adapter: string, account: string, scope: string, conversation: string) =>
    Schema.decodeUnknownSync(Schema.NullOr(Binding))(
      database
        .query(
          `SELECT session_id AS sessionId FROM gateway_bindings WHERE adapter = ? AND account = ? AND scope_id = ? AND conversation_id = ?`,
        )
        .get(adapter, account, scope, conversation),
    )?.sessionId ?? null;

  return {
    item,
    binding,
    accept: (adapter: string, account: string, message: IncomingMessage) =>
      database
        .transaction(() => {
          if (
            database
              .query(
                "SELECT id FROM gateway_inbox WHERE adapter = ? AND account = ? AND external_id = ?",
              )
              .get(adapter, account, message.messageId)
          )
            return null;

          const counts = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Natural }))(
            database
              .query(
                "SELECT COUNT(*) AS count FROM gateway_inbox WHERE adapter = ? AND account = ? AND state IN ('queued', 'executing')",
              )
              .get(adapter, account),
          );

          if (counts.count >= 64 && message.text !== "/status" && message.text !== "/cancel")
            throw new ChannelError({
              reason: "overloaded",
              message: "Messaging queue is full. Try again later.",
            });

          const result = database
            .query(`INSERT INTO gateway_inbox (adapter, account, external_id, payload, conversation_id, run_id, state)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(
              adapter,
              account,
              message.messageId,
              JSON.stringify(message),
              message.conversationId,
              randomUUID(),
              message.text === "/status" || message.text === "/cancel" ? "cancelled" : "queued",
            );

          return item(Number(result.lastInsertRowid));
        })
        .immediate(),
    next: (adapter: string, account: string, now: number) =>
      Schema.decodeUnknownSync(Schema.NullOr(Inbox))(
        database
          .query(`${inboxSql} WHERE adapter = ? AND account = ? AND state = 'queued' AND retry_at <= ?
        AND NOT EXISTS (SELECT 1 FROM gateway_inbox earlier WHERE earlier.adapter = ? AND earlier.account = ?
          AND json_extract(earlier.payload, '$.parentId') = json_extract(gateway_inbox.payload, '$.parentId')
          AND COALESCE(earlier.conversation_id, earlier.external_id) = COALESCE(gateway_inbox.conversation_id, gateway_inbox.external_id)
          AND earlier.state IN ('queued', 'executing') AND earlier.id < gateway_inbox.id)
        ORDER BY id LIMIT 1`)
          .get(adapter, account, now, adapter, account),
      ),
    retry: (entry: Inbox, retryAt: number) =>
      database
        .query(
          "UPDATE gateway_inbox SET state = 'queued', attempts = attempts + 1, retry_at = ? WHERE id = ?",
        )
        .run(retryAt, entry.id),
    executing: (adapter: string, account: string) =>
      Schema.decodeUnknownSync(Schema.Array(Inbox))(
        database
          .query(
            `${inboxSql} WHERE adapter = ? AND account = ? AND state = 'executing' ORDER BY id`,
          )
          .all(adapter, account),
      ),
    attach: (id: number, conversation: string, session: string) =>
      database
        .transaction(() => {
          const entry = item(id);
          database
            .query(`INSERT INTO gateway_bindings (adapter, account, scope_id, conversation_id, session_id)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
            .run(entry.adapter, entry.account, entry.message.scopeId, conversation, session);

          if (
            binding(entry.adapter, entry.account, entry.message.scopeId, conversation) !== session
          )
            throw new Error("Conflicting messaging session");
          database
            .query("UPDATE gateway_inbox SET conversation_id = ?, session_id = ? WHERE id = ?")
            .run(conversation, session, id);
        })
        .immediate(),
    state: (id: number, state: string) =>
      database.query("UPDATE gateway_inbox SET state = ? WHERE id = ?").run(state, id),
    cancel: (adapter: string, account: string, conversation: string) =>
      database
        .query(`UPDATE gateway_inbox SET state = 'cancelled'
      WHERE adapter = ? AND account = ? AND conversation_id = ? AND state = 'queued'`)
        .run(adapter, account, conversation),
    complete: (id: number, chunks: ReadonlyArray<string>, state = "completed") =>
      database
        .transaction(() => {
          // Reconciliation can observe a committed run before its delivery was recorded.
          for (const [position, text] of chunks.entries())
            database
              .query(`INSERT INTO gateway_deliveries (inbox_id, position, text, state)
        VALUES (?, ?, ?, 'pending') ON CONFLICT DO NOTHING`)
              .run(id, position, text);
          database.query("UPDATE gateway_inbox SET state = ? WHERE id = ?").run(state, id);
        })
        .immediate(),
    nextDelivery: (adapter: string, account: string, now: number) =>
      Schema.decodeUnknownSync(Schema.NullOr(Delivery))(
        database
          .query(`
      SELECT d.inbox_id AS inboxId, d.position, d.text, d.attempts FROM gateway_deliveries d
      JOIN gateway_inbox i ON i.id = d.inbox_id
      WHERE i.adapter = ? AND i.account = ? AND d.state = 'pending' AND d.retry_at <= ?
      AND NOT EXISTS (SELECT 1 FROM gateway_deliveries earlier WHERE earlier.inbox_id = d.inbox_id AND earlier.position < d.position AND earlier.state != 'sent')
      ORDER BY d.inbox_id, d.position LIMIT 1`)
          .get(adapter, account, now),
      ),
    delivering: (entry: Delivery) =>
      database
        .query(
          "UPDATE gateway_deliveries SET state = 'sending' WHERE inbox_id = ? AND position = ?",
        )
        .run(entry.inboxId, entry.position),
    delivered: (entry: Delivery, messageId: string) =>
      database
        .query(
          "UPDATE gateway_deliveries SET state = 'sent', message_id = ? WHERE inbox_id = ? AND position = ?",
        )
        .run(messageId, entry.inboxId, entry.position),
    deliveryFailed: (entry: Delivery, state: string, retryAt: number) =>
      database
        .query(
          "UPDATE gateway_deliveries SET state = ?, attempts = attempts + 1, retry_at = ? WHERE inbox_id = ? AND position = ?",
        )
        .run(state, retryAt, entry.inboxId, entry.position),
    recoverDelivery: (adapter: string, account: string) =>
      database
        .query(`UPDATE gateway_deliveries SET state = 'uncertain' WHERE state = 'sending'
          AND inbox_id IN (SELECT id FROM gateway_inbox WHERE adapter = ? AND account = ?)`)
        .run(adapter, account),
    status: () =>
      Schema.decodeUnknownSync(
        Schema.Struct({
          queued: Schema.Natural,
          executing: Schema.Natural,
          pendingDelivery: Schema.Natural,
          failedDelivery: Schema.Natural,
          uncertainDelivery: Schema.Natural,
          failedRequests: Schema.Natural,
        }),
      )(
        database
          .query(`SELECT
        (SELECT COUNT(*) FROM gateway_inbox WHERE state = 'queued') AS queued,
        (SELECT COUNT(*) FROM gateway_inbox WHERE state = 'executing') AS executing,
        (SELECT COUNT(*) FROM gateway_deliveries WHERE state IN ('pending', 'sending')) AS pendingDelivery,
        (SELECT COUNT(*) FROM gateway_deliveries WHERE state = 'failed') AS failedDelivery,
        (SELECT COUNT(*) FROM gateway_deliveries WHERE state = 'uncertain') AS uncertainDelivery,
        (SELECT COUNT(*) FROM gateway_inbox WHERE state = 'failed') AS failedRequests`)
          .get(),
      ),
  };
});

export class GatewayRepository extends Context.Service<
  GatewayRepository,
  Effect.Success<typeof repository>
>()("poppet/GatewayRepository") {}

export const GatewayRepositoryLive = Layer.effect(GatewayRepository, repository);
