import { Database } from "bun:sqlite";

import { Schema } from "effect";

import { StoreError, readRecord } from "#src/errors";
import { Session, SessionReadMessage, SessionReadQuery, type SessionReadResult } from "#src/schema";

const RecallRow = Schema.Struct({
  messageId: SessionReadMessage.fields.messageId,
  role: SessionReadMessage.fields.role,
  createdAt: Schema.Natural,
  text: Schema.String,
  textBytes: Schema.Natural,
});

/** Reads bounded windows from the same eligibility projection used to build search. */
export const readSession = (
  database: Database,
  query: SessionReadQuery,
  maxBytes: number,
): SessionReadResult => {
  const { sessionId, aroundMessageId, afterMessageId } = Schema.decodeUnknownSync(
    SessionReadQuery,
    { onExcessProperty: "error" },
  )(query);

  Schema.decodeUnknownSync(Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65536 })))(
    maxBytes,
  );

  const session = readRecord(() =>
    Schema.decodeUnknownSync(
      Schema.NullOr(Schema.Struct({ id: Session.fields.id, title: Session.fields.title })),
    )(database.query("SELECT id, title FROM sessions WHERE id = ?").get(sessionId)),
  );

  if (session === null)
    throw new StoreError({ reason: "not-found", message: "The recalled session does not exist." });

  const anchorId = aroundMessageId ?? afterMessageId;

  const anchor =
    anchorId === null
      ? null
      : readRecord(() =>
          Schema.decodeUnknownSync(Schema.NullOr(Schema.Struct({ position: Schema.Natural })))(
            database
              .query(`SELECT m.position FROM messages AS m
                JOIN session_search AS eligible ON eligible.rowid = m.id
                WHERE m.session_id = ? AND m.id = ?`)
              .get(sessionId, anchorId),
          ),
        );

  if (anchorId !== null && anchor === null)
    throw new StoreError({
      reason: "invalid-request",
      message: "The recall anchor is not an eligible message in this session.",
    });

  // Indexed IDs gate projection reads, avoiding evaluation of excluded tool payloads as assistant text.
  const window = (before: boolean, position: number, limit: number) =>
    readRecord(() =>
      Schema.decodeUnknownSync(Schema.Array(RecallRow))(
        database
          .query(`SELECT messageId, role, createdAt, substr(text, 1, ?) AS text,
            length(CAST(text AS BLOB)) AS textBytes FROM (
              SELECT m.position, m.id AS messageId, json_extract(m.payload, '$.role') AS role,
                m.created_at AS createdAt,
                (SELECT text FROM searchable_messages WHERE id = m.id) AS text
              FROM messages AS m JOIN session_search AS eligible ON eligible.rowid = m.id
              WHERE m.session_id = ? AND m.position ${before ? "<=" : ">"} ?
              ORDER BY m.position ${before ? "DESC" : "ASC"} LIMIT ?
            ) ORDER BY position ${before ? "DESC" : "ASC"}`)
          .all(maxBytes, sessionId, position, limit),
      ),
    );

  const before = aroundMessageId === null ? [] : window(true, anchor!.position, 6).toReversed();
  let omittedBefore = before.length > 5;

  const rows = [
    ...before.slice(-5),
    ...window(false, anchor?.position ?? -1, aroundMessageId === null ? 11 : 6),
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
};
