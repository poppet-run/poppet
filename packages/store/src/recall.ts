import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";

import { StoreError, decodeInput } from "#src/errors";
import { Session, SessionReadMessage, SessionReadQuery, type SessionReadResult } from "#src/schema";
import { MaxBytes, clip } from "#src/search";
import { decodeRow, decodeRows } from "#src/sql";

const RecallRow = Schema.Struct({
  messageId: SessionReadMessage.fields.messageId,
  role: SessionReadMessage.fields.role,
  createdAt: Schema.Natural,
  text: Schema.String,
  textBytes: Schema.Natural,
});

/** Reads bounded windows from the same eligibility projection used to build search. */
export const readSession = Effect.fn(function* (
  sql: SqlClient.SqlClient,
  query: SessionReadQuery,
  maxBytes: number,
) {
  const { sessionId, aroundMessageId, afterMessageId } = yield* decodeInput(
    SessionReadQuery,
    query,
    { onExcessProperty: "error" },
  );

  yield* decodeInput(MaxBytes, maxBytes);

  const session = yield* sql`SELECT id, title FROM sessions WHERE id = ${sessionId}`.pipe(
    decodeRow(Schema.Struct({ id: Session.fields.id, title: Session.fields.title })),
  );

  if (session === null)
    return yield* new StoreError({
      reason: "not-found",
      message: "The recalled session does not exist.",
    });

  const anchorId = aroundMessageId ?? afterMessageId;

  const anchor =
    anchorId === null
      ? null
      : yield* sql`SELECT m.position FROM messages AS m
          JOIN session_search AS eligible ON eligible.rowid = m.id
          WHERE m.session_id = ${sessionId} AND m.id = ${anchorId}`.pipe(
          decodeRow(Schema.Struct({ position: Schema.Natural })),
        );

  if (anchorId !== null && anchor === null)
    return yield* new StoreError({
      reason: "invalid-request",
      message: "The recall anchor is not an eligible message in this session.",
    });

  // Indexed IDs gate projection reads, avoiding evaluation of excluded tool payloads as assistant text.
  const window = (before: boolean, position: number, limit: number) => {
    const comparison = sql.literal(before ? "<=" : ">");
    const direction = sql.literal(before ? "DESC" : "ASC");

    return sql`SELECT message_id, role, created_at, substr(text, 1, ${maxBytes}) AS text,
        length(CAST(text AS BLOB)) AS text_bytes FROM (
          SELECT m.position, m.id AS message_id, json_extract(m.payload, '$.role') AS role,
            m.created_at, (SELECT text FROM searchable_messages WHERE id = m.id) AS text
          FROM messages AS m JOIN session_search AS eligible ON eligible.rowid = m.id
          WHERE m.session_id = ${sessionId} AND m.position ${comparison} ${position}
          ORDER BY m.position ${direction} LIMIT ${limit}
        ) ORDER BY position ${direction}`.pipe(decodeRows(RecallRow));
  };

  // The budget sets the page size and each message's text length; results stay close to it.
  const pageSize = Math.min(10, Math.max(1, Math.floor(maxBytes / 400)));
  const textBytes = Math.floor(maxBytes / pageSize) - 150;

  // An around-read spends about half the page on the anchor and the messages before it,
  // always including at least one earlier message when the page has room.
  const leading =
    aroundMessageId === null ? 0 : Math.min(pageSize, Math.max(2, Math.ceil(pageSize / 2)));

  const before =
    leading === 0 ? [] : (yield* window(true, anchor!.position, leading + 1)).toReversed();

  const kept = before.slice(-leading);

  const after = yield* window(false, anchor?.position ?? -1, pageSize - kept.length + 1);
  const rows = [...kept, ...after];
  const page = rows.slice(0, pageSize);
  const more = rows.length > pageSize;

  const messages = page.map(({ text, textBytes: savedBytes, ...row }) => {
    const shown = clip(text, textBytes);

    return { ...row, text: shown, truncated: Buffer.byteLength(shown) < savedBytes };
  });

  return {
    sessionId,
    title: session.title,
    messages,
    nextAfterMessageId: more ? (page.at(-1)?.messageId ?? null) : null,
    truncated: before.length > leading || more || messages.some((message) => message.truncated),
  } satisfies SessionReadResult;
});
