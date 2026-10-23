import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";

import { StoreError, decodeInput } from "#src/errors";
import { Session, SessionReadMessage, SessionReadQuery, type SessionReadResult } from "#src/schema";
import { MaxBytes } from "#src/search";
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

  const before =
    aroundMessageId === null ? [] : (yield* window(true, anchor!.position, 6)).toReversed();

  let omittedBefore = before.length > 5;

  const rows = [
    ...before.slice(-5),
    ...(yield* window(false, anchor?.position ?? -1, aroundMessageId === null ? 11 : 6)),
  ];

  const selected = rows.slice(0, 10).map((row) => ({
    messageId: row.messageId,
    role: row.role,
    createdAt: row.createdAt,
    textBytes: row.textBytes,
    characters: [...row.text],
    text: row.text,
    truncated: Buffer.byteLength(row.text) < row.textBytes,
  }));

  const result = (): SessionReadResult => {
    const last = selected.at(-1)?.messageId ?? null;
    const more = last !== null && last !== rows.at(-1)?.messageId;

    return {
      sessionId,
      title: session.title,
      messages: selected.map(({ messageId, role, createdAt, text, truncated }) => ({
        messageId,
        role,
        createdAt,
        text,
        truncated,
      })),
      nextAfterMessageId: more ? last : null,
      truncated: omittedBefore || more || selected.some((row) => row.truncated),
    };
  };

  const size = () => Buffer.byteLength(JSON.stringify(result()));

  if (size() <= maxBytes) return result();

  for (const row of selected) {
    row.text = "";
    row.truncated = row.textBytes > 0;
  }

  // Keep the requested match even when metadata alone forces a smaller window.
  while (size() > maxBytes) {
    if (aroundMessageId !== null && selected[0]?.messageId !== aroundMessageId) {
      selected.shift();
      omittedBefore = true;
    } else selected.pop();
  }

  for (const [index, row] of selected.entries()) {
    const allowance = Math.floor((maxBytes - size()) / (selected.length - index));
    const ceiling = size() + allowance;
    let lower = 0;
    let upper = row.characters.length;

    const setText = (length: number) => {
      row.text = row.characters.slice(0, length).join("");
      row.truncated = Buffer.byteLength(row.text) < row.textBytes;
    };

    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2);
      setText(middle);

      if (size() <= ceiling) lower = middle;
      else upper = middle - 1;
    }

    setText(lower);
  }

  return result();
});
