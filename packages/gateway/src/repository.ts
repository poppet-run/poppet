import { randomUUID } from "node:crypto";

import {
  DeliveryDestination,
  StoreError,
  decodeRow,
  decodeRows,
  migrate,
  reportAs,
} from "@poppet/store";
import { DeliveryState, TaskDeliveries, TaskError, taskSchema } from "@poppet/tasks";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { IncomingMessage, ChannelError } from "#src/channel";
import { gatewaySchema } from "#src/migrations";
import { isControl } from "#src/request";

const InboxState = Schema.Literals(["queued", "executing", "completed", "cancelled", "failed"]);

export type InboxState = typeof InboxState.Type;

export interface BindingKey {
  readonly adapter: string;
  readonly account: string;
  readonly conversation: string;
  readonly session: string;
}

const Inbox = Schema.Struct({
  id: Schema.Natural,
  adapter: Schema.String,
  account: Schema.String,
  message: Schema.fromJsonString(IncomingMessage),
  conversationId: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  runId: Schema.String,
  state: InboxState,
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

const Binding = Schema.Struct({
  sessionId: Schema.String,
  managedName: Schema.NullOr(Schema.String),
  syncedTitle: Schema.NullOr(Schema.String),
  pendingName: Schema.NullOr(Schema.String),
  namingDisabled: Schema.BooleanFromBit,
  creationMessageId: Schema.NullOr(Schema.String),
});

const gatewayFailure = (cause: unknown) =>
  cause instanceof ChannelError
    ? cause
    : new StoreError({ reason: "storage", message: "Cannot read or write messaging records." });

const operation =
  <Args extends ReadonlyArray<unknown>, A, E, R>(run: (...args: Args) => Effect.Effect<A, E, R>) =>
  (...args: Args) =>
    run(...args).pipe(reportAs(gatewayFailure));

const conflictingSession = () => new Error("Conflicting messaging session");

const repository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* migrate(taskSchema);
  yield* migrate(gatewaySchema);

  const inbox = sql`SELECT id, adapter, account, payload AS message, conversation_id, session_id,
    run_id, state, attempts FROM gateway_inbox`;

  const item = (id: number) =>
    sql`${inbox} WHERE id = ${id}`.pipe(
      decodeRow(Inbox),
      Effect.flatMap((row) =>
        row === null ? Effect.fail(new Error("Missing messaging request")) : Effect.succeed(row),
      ),
    );

  const binding = (adapter: string, account: string, scope: string, conversation: string) =>
    sql`SELECT session_id FROM gateway_bindings WHERE adapter = ${adapter} AND account = ${account}
      AND scope_id = ${scope} AND conversation_id = ${conversation}`.pipe(
      decodeRow(Schema.Struct({ sessionId: Schema.String })),
      Effect.map((row) => row?.sessionId ?? null),
    );

  const namedBinding = (adapter: string, account: string, conversation: string) =>
    sql`SELECT session_id, managed_name, synced_title, pending_name, naming_disabled,
      creation_message_id FROM gateway_bindings
      WHERE adapter = ${adapter} AND account = ${account} AND conversation_id = ${conversation}`.pipe(
      decodeRow(Binding),
    );

  const insertDeliveries = (
    inboxId: number,
    chunks: ReadonlyArray<string>,
    state: "pending" | "failed",
    ignoreExisting = false,
  ) =>
    chunks.length === 0
      ? Effect.void
      : sql`INSERT INTO gateway_deliveries ${sql.insert(
          chunks.map((text, position) => ({ inboxId, position, text, state })),
        )} ${sql.literal(ignoreExisting ? "ON CONFLICT DO NOTHING" : "")}`.pipe(Effect.asVoid);

  return {
    rejectScheduledDeliveries: operation((adapter: string, account: string) =>
      sql`UPDATE gateway_deliveries SET state = 'failed' WHERE state = 'pending' AND inbox_id IN (
        SELECT id FROM gateway_inbox WHERE adapter = ${adapter} AND occurrence_id IS NOT NULL
          AND (account != ${account} OR EXISTS (
            SELECT 1 FROM runs r WHERE r.id = gateway_inbox.run_id AND r.status != 'completed'
          ))
      )`.pipe(Effect.asVoid),
    ),
    scheduled: operation((adapter: string) =>
      sql`SELECT o.id, o.run_id, o.destination FROM job_occurrences o
        WHERE o.status = 'completed' AND o.run_id IS NOT NULL
          AND json_extract(o.destination, '$.adapter') = ${adapter}
          AND NOT EXISTS (SELECT 1 FROM gateway_inbox i
            WHERE i.occurrence_id = o.id AND i.run_id = o.run_id)
        ORDER BY o.scheduled_at, o.id LIMIT 64`.pipe(
        decodeRows(
          Schema.Struct({
            id: Schema.String,
            runId: Schema.String,
            destination: Schema.fromJsonString(DeliveryDestination),
          }),
        ),
      ),
    ),
    failedScheduled: operation((adapter: string, since: number) =>
      sql`SELECT o.id, o.job_id, o.destination, json_extract(o.definition, '$.name') AS name,
          'notice:' || o.id || ':' || o.finished_at AS notice_id,
          CASE WHEN o.run_id IS NULL THEN 'before-start' ELSE COALESCE(
            (SELECT r.failure_reason FROM runs r WHERE r.id = o.run_id), 'unknown') END AS reason,
          COALESCE((SELECT p.status = 'failed' FROM job_occurrences p
            WHERE p.job_id = o.job_id AND p.finished_at IS NOT NULL
              AND (p.finished_at, p.rowid) < (o.finished_at, o.rowid)
            ORDER BY p.finished_at DESC, p.rowid DESC LIMIT 1), 0) AS repeated
        FROM job_occurrences o
        WHERE o.status = 'failed' AND o.finished_at >= ${since}
          AND json_extract(o.destination, '$.adapter') = ${adapter}
          AND NOT EXISTS (SELECT 1 FROM gateway_inbox i WHERE i.occurrence_id = o.id
            AND i.run_id = 'notice:' || o.id || ':' || o.finished_at)
        ORDER BY o.finished_at, o.rowid LIMIT 64`.pipe(
        decodeRows(
          Schema.Struct({
            id: Schema.String,
            jobId: Schema.String,
            destination: Schema.fromJsonString(DeliveryDestination),
            name: Schema.String,
            noticeId: Schema.String,
            reason: Schema.String,
            repeated: Schema.BooleanFromBit,
          }),
        ),
      ),
    ),
    scheduleResult: operation(
      (
        id: string,
        runId: string,
        destination: DeliveryDestination,
        chunks: ReadonlyArray<string>,
        enabled: boolean,
      ) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const message: IncomingMessage = {
              messageId: `task-${id}-${runId}`,
              senderId: destination.ownerId,
              scopeId: destination.scopeId,
              parentId: destination.parentId,
              conversationId: destination.conversationId,
              text: "",
              mentioned: false,
            };

            const inserted = yield* sql`INSERT INTO gateway_inbox ${sql.insert({
              adapter: destination.adapter,
              account: destination.account,
              externalId: message.messageId,
              payload: JSON.stringify(message),
              conversationId: destination.conversationId,
              runId,
              state: "completed",
              occurrenceId: id,
            })} ON CONFLICT DO NOTHING RETURNING id`.pipe(
              decodeRow(Schema.Struct({ id: Schema.Natural })),
            );

            if (inserted === null) return;

            yield* insertDeliveries(inserted.id, chunks, enabled ? "pending" : "failed");
          }),
        ),
    ),
    namedBinding: operation(namedBinding),
    namingEntry: operation((adapter: string, account: string, conversation: string) =>
      sql`${inbox} WHERE adapter = ${adapter} AND account = ${account}
        AND conversation_id = ${conversation} AND session_id IS NOT NULL ORDER BY id LIMIT 1`.pipe(
        decodeRow(Inbox),
      ),
    ),
    nameAttempted: operation(
      ({ adapter, account, conversation, session }: BindingKey, title: string | null) =>
        sql`UPDATE gateway_bindings SET synced_title = ${title} WHERE adapter = ${adapter}
        AND account = ${account} AND conversation_id = ${conversation}
        AND session_id = ${session}`.pipe(Effect.asVoid),
    ),
    namePending: operation(
      ({ adapter, account, conversation, session }: BindingKey, name: string) =>
        sql`UPDATE gateway_bindings SET pending_name = ${name} WHERE adapter = ${adapter}
        AND account = ${account} AND conversation_id = ${conversation} AND naming_disabled = 0
        AND session_id = ${session} RETURNING 1`.pipe(Effect.map((rows) => rows.length === 1)),
    ),
    nameConfirmed: operation(
      ({ adapter, account, conversation, session }: BindingKey, name: string) =>
        sql`UPDATE gateway_bindings SET managed_name = ${name}, pending_name = NULL
        WHERE adapter = ${adapter} AND account = ${account} AND conversation_id = ${conversation}
          AND naming_disabled = 0 AND session_id = ${session}`.pipe(Effect.asVoid),
    ),
    disableNaming: operation(({ adapter, account, conversation, session }: BindingKey) =>
      sql`UPDATE gateway_bindings SET naming_disabled = 1, pending_name = NULL
        WHERE adapter = ${adapter} AND account = ${account} AND conversation_id = ${conversation}
          AND session_id = ${session}`.pipe(Effect.asVoid),
    ),
    namingEntries: operation((adapter: string, account: string) =>
      sql`${inbox} WHERE adapter = ${adapter} AND account = ${account}
        AND session_id IS NOT NULL AND state = 'completed'
        AND id = (SELECT MIN(first.id) FROM gateway_inbox first
          WHERE first.session_id = gateway_inbox.session_id AND first.state = 'completed'
            AND EXISTS (SELECT 1 FROM runs r WHERE r.id = first.run_id AND r.status = 'completed'))
        AND EXISTS (SELECT 1 FROM runs r WHERE r.id = gateway_inbox.run_id AND r.status = 'completed')
        AND EXISTS (SELECT 1 FROM gateway_deliveries d WHERE d.inbox_id = gateway_inbox.id)
        AND NOT EXISTS (SELECT 1 FROM gateway_deliveries d
          WHERE d.inbox_id = gateway_inbox.id AND d.state != 'sent')
        AND (EXISTS (SELECT 1 FROM sessions s WHERE s.id = gateway_inbox.session_id
            AND s.title_source = 'fallback' AND s.title_attempted = 0)
          OR EXISTS (SELECT 1 FROM gateway_bindings b JOIN sessions s ON s.id = b.session_id
            WHERE b.session_id = gateway_inbox.session_id AND b.managed_name IS NOT NULL
              AND b.naming_disabled = 0
              AND (b.pending_name IS NOT NULL OR b.synced_title IS NOT s.title)))
        ORDER BY id`.pipe(decodeRows(Inbox)),
    ),
    item: operation(item),
    binding: operation(binding),
    accept: operation((adapter: string, account: string, message: IncomingMessage) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const duplicate = yield* sql`SELECT id FROM gateway_inbox WHERE adapter = ${adapter}
            AND account = ${account} AND external_id = ${message.messageId}`;

          if (duplicate.length > 0) return null;

          const queued = yield* sql`SELECT COUNT(*) AS count FROM gateway_inbox
            WHERE adapter = ${adapter} AND account = ${account}
              AND state IN ('queued', 'executing')`.pipe(
            decodeRow(Schema.Struct({ count: Schema.Natural })),
          );

          const control = isControl(message.text);

          if ((queued?.count ?? 0) >= 64 && !control)
            return yield* new ChannelError({
              reason: "overloaded",
              message: "Messaging queue is full. Try again later.",
            });

          const inserted = yield* sql`INSERT INTO gateway_inbox ${sql.insert({
            adapter,
            account,
            externalId: message.messageId,
            payload: JSON.stringify(message),
            conversationId: message.conversationId,
            runId: randomUUID(),
            state: control ? "cancelled" : "queued",
          })} RETURNING id`.pipe(decodeRows(Schema.Struct({ id: Schema.Natural })));

          return yield* item(inserted[0]!.id);
        }),
      ),
    ),
    next: operation((adapter: string, account: string, now: number) =>
      sql`${inbox} WHERE adapter = ${adapter} AND account = ${account} AND state = 'queued'
        AND retry_at <= ${now}
        AND NOT EXISTS (SELECT 1 FROM gateway_inbox earlier
          WHERE earlier.adapter = ${adapter} AND earlier.account = ${account}
            AND json_extract(earlier.payload, '$.parentId') = json_extract(gateway_inbox.payload, '$.parentId')
            AND COALESCE(earlier.conversation_id, earlier.external_id) =
              COALESCE(gateway_inbox.conversation_id, gateway_inbox.external_id)
            AND earlier.state IN ('queued', 'executing') AND earlier.id < gateway_inbox.id)
        ORDER BY id LIMIT 1`.pipe(decodeRow(Inbox)),
    ),
    claim: operation((id: number) =>
      sql`UPDATE gateway_inbox SET state = 'executing' WHERE id = ${id} AND state = 'queued'
        RETURNING id`.pipe(Effect.map((rows) => rows.length > 0)),
    ),
    retry: operation((entry: Inbox, retryAt: number) =>
      sql`UPDATE gateway_inbox SET state = 'queued', attempts = attempts + 1, retry_at = ${retryAt}
        WHERE id = ${entry.id}`.pipe(Effect.asVoid),
    ),
    executing: operation((adapter: string, account: string) =>
      sql`${inbox} WHERE adapter = ${adapter} AND account = ${account} AND state = 'executing'
        ORDER BY id`.pipe(decodeRows(Inbox)),
    ),
    attach: operation(
      (
        id: number,
        conversation: string,
        session: string,
        managedName: string | null = null,
        replace = false,
      ) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const entry = yield* item(id);

            yield* sql`INSERT INTO gateway_bindings ${sql.insert({
              adapter: entry.adapter,
              account: entry.account,
              scopeId: entry.message.scopeId,
              conversationId: conversation,
              sessionId: session,
              managedName,
              creationMessageId: managedName === null ? null : entry.message.messageId,
            })} ON CONFLICT DO NOTHING`;

            if (replace)
              yield* sql`UPDATE gateway_bindings SET session_id = ${session}, synced_title = NULL
              WHERE adapter = ${entry.adapter} AND account = ${entry.account}
                AND scope_id = ${entry.message.scopeId} AND conversation_id = ${conversation}
                AND session_id != ${session}`;

            const bound = yield* binding(
              entry.adapter,
              entry.account,
              entry.message.scopeId,
              conversation,
            );

            if (bound !== session) return yield* Effect.fail(conflictingSession());

            yield* sql`UPDATE gateway_inbox SET conversation_id = ${conversation},
            session_id = ${session} WHERE id = ${id}`;
          }),
        ),
    ),
    address: operation((id: number, conversation: string) =>
      sql`UPDATE gateway_inbox SET conversation_id = ${conversation} WHERE id = ${id}`.pipe(
        Effect.asVoid,
      ),
    ),
    state: operation((id: number, state: InboxState) =>
      sql`UPDATE gateway_inbox SET state = ${state} WHERE id = ${id}`.pipe(Effect.asVoid),
    ),
    cancel: operation((adapter: string, account: string, conversation: string) =>
      sql`UPDATE gateway_inbox SET state = 'cancelled' WHERE adapter = ${adapter}
        AND account = ${account} AND conversation_id = ${conversation}
        AND state = 'queued'`.pipe(Effect.asVoid),
    ),
    complete: operation(
      (
        id: number,
        chunks: ReadonlyArray<string>,
        state: Extract<InboxState, "completed" | "failed"> = "completed",
      ) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* insertDeliveries(id, chunks, "pending", true);
            yield* sql`UPDATE gateway_inbox SET state = ${state} WHERE id = ${id}`;
          }),
        ),
    ),
    nextDelivery: operation((adapter: string, account: string, now: number) =>
      sql`SELECT d.inbox_id, d.position, d.text, d.attempts FROM gateway_deliveries d
        JOIN gateway_inbox i ON i.id = d.inbox_id
        WHERE i.adapter = ${adapter} AND i.account = ${account} AND d.state = 'pending'
          AND d.retry_at <= ${now}
          AND NOT EXISTS (SELECT 1 FROM gateway_deliveries earlier
            WHERE earlier.inbox_id = d.inbox_id AND earlier.position < d.position
              AND earlier.state != 'sent')
        ORDER BY d.inbox_id, d.position LIMIT 1`.pipe(decodeRow(Delivery)),
    ),
    delivering: operation((entry: Delivery) =>
      sql`UPDATE gateway_deliveries SET state = 'sending'
        WHERE inbox_id = ${entry.inboxId} AND position = ${entry.position}`.pipe(Effect.asVoid),
    ),
    delivered: operation((entry: Delivery, messageId: string) =>
      sql`UPDATE gateway_deliveries SET state = 'sent', message_id = ${messageId}
        WHERE inbox_id = ${entry.inboxId} AND position = ${entry.position}`.pipe(Effect.asVoid),
    ),
    deliveryFailed: operation(
      (
        entry: Delivery,
        state: Extract<DeliveryState, "pending" | "failed" | "uncertain">,
        retryAt: number,
      ) =>
        sql`UPDATE gateway_deliveries SET state = ${state}, attempts = attempts + 1,
        retry_at = ${retryAt} WHERE inbox_id = ${entry.inboxId}
          AND position = ${entry.position}`.pipe(Effect.asVoid),
    ),
    recoverDelivery: operation((adapter: string, account: string) =>
      sql`UPDATE gateway_deliveries SET state = 'uncertain' WHERE state = 'sending'
        AND inbox_id IN (SELECT id FROM gateway_inbox
          WHERE adapter = ${adapter} AND account = ${account})`.pipe(Effect.asVoid),
    ),
    status: operation(() =>
      sql`SELECT
        (SELECT COUNT(*) FROM gateway_inbox WHERE state = 'queued') AS queued,
        (SELECT COUNT(*) FROM gateway_inbox WHERE state = 'executing') AS executing,
        (SELECT COUNT(*) FROM gateway_deliveries
          WHERE state IN ('pending', 'sending')) AS pending_delivery,
        (SELECT COUNT(*) FROM gateway_deliveries WHERE state = 'failed') AS failed_delivery,
        (SELECT COUNT(*) FROM gateway_deliveries WHERE state = 'uncertain') AS uncertain_delivery,
        (SELECT COUNT(*) FROM gateway_inbox WHERE state = 'failed') AS failed_requests`.pipe(
        decodeRows(
          Schema.Struct({
            queued: Schema.Natural,
            executing: Schema.Natural,
            pendingDelivery: Schema.Natural,
            failedDelivery: Schema.Natural,
            uncertainDelivery: Schema.Natural,
            failedRequests: Schema.Natural,
          }),
        ),
        Effect.map((rows) => rows[0]!),
      ),
    ),
  };
});

export class GatewayRepository extends Context.Service<
  GatewayRepository,
  Effect.Success<typeof repository>
>()("poppet/GatewayRepository") {}

export const GatewayRepositoryLive = Layer.effect(GatewayRepository, repository);

const Delivered = Schema.Struct({
  runId: Schema.String,
  position: Schema.Natural,
  state: DeliveryState,
  messageId: Schema.NullOr(Schema.String),
  attempts: Schema.Natural,
});

export const TaskDeliveriesLive = Layer.effect(
  TaskDeliveries,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* migrate(gatewaySchema);

    return {
      forOccurrence: (occurrenceId: string) =>
        sql`SELECT i.run_id, d.position, d.state, d.message_id, d.attempts
          FROM gateway_deliveries d JOIN gateway_inbox i ON i.id = d.inbox_id
          WHERE i.occurrence_id = ${occurrenceId} ORDER BY i.id, d.position`.pipe(
          decodeRows(Delivered),
          reportAs(() => new TaskError({ message: "Could not read or update scheduled tasks." })),
        ),
    };
  }),
);
