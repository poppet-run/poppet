import { randomUUID } from "node:crypto";

import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";

import { decodeInput } from "#src/errors";
import { SessionSearchMatch, SessionSearchQuery, type SessionSearchResult } from "#src/schema";
import { decodeRows } from "#src/sql";

/** Bounds a caller-supplied JSON byte budget. */
export const MaxBytes = Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65536 }));

/** Searches completed exchanges and keeps excerpts around their match within the JSON byte budget. */
export const searchSessions = Effect.fn(function* (
  sql: SqlClient.SqlClient,
  query: string,
  maxBytes: number,
) {
  const text = yield* decodeInput(SessionSearchQuery, query);
  yield* decodeInput(MaxBytes, maxBytes);

  const terms = text
    .split(/\s+/u)
    .filter((term) => /[\p{L}\p{N}]/u.test(term))
    .map((term) => `"${term.replaceAll('"', '""')}"`);

  if (terms.length === 0) return { matches: [], truncated: false } satisfies SessionSearchResult;

  // Use a fresh marker so stored text cannot be mistaken for a match boundary.
  const marker = randomUUID();

  const rows = yield* sql`SELECT m.session_id, m.id AS message_id, s.title, m.created_at,
      json_extract(m.payload, '$.role') AS role,
      snippet(session_search, 0, ${marker}, ${marker}, '', 48) AS excerpt,
      length(session_search.text) AS text_length
    FROM session_search JOIN messages AS m ON m.id = session_search.rowid
    JOIN sessions AS s ON s.id = m.session_id
    WHERE session_search MATCH ${terms.join(" AND ")}
    ORDER BY rank, m.id LIMIT 11`.pipe(
    decodeRows(Schema.Struct({ ...SessionSearchMatch.fields, textLength: Schema.Natural })),
  );

  const matches: Array<typeof SessionSearchMatch.Type> = [];
  let truncated = rows.length > 10;

  for (const { textLength, ...row } of rows.slice(0, 10)) {
    const [before = "", hit = ""] = row.excerpt.split(marker);
    const characters = [...row.excerpt.replaceAll(marker, "")];
    const offset = [...before].length;
    const hitLength = [...hit].length;
    truncated ||= characters.length > 1000 || characters.length < textLength;
    let length = Math.min(1000, characters.length);

    if (hitLength > length) continue;

    const excerpt = () => {
      const start = Math.max(
        0,
        Math.min(offset - Math.floor((length - hitLength) / 2), characters.length - length),
      );

      return characters.slice(start, start + length).join("");
    };

    let match = { ...row, excerpt: excerpt() };

    while (
      Buffer.byteLength(JSON.stringify({ matches: [...matches, match], truncated: true })) >
      maxBytes
    ) {
      if (length === hitLength) return { matches, truncated: true } satisfies SessionSearchResult;
      length = Math.max(hitLength, Math.floor(length / 2));
      match = { ...row, excerpt: excerpt() };
      truncated = true;
    }

    matches.push(match);
  }

  return { matches, truncated } satisfies SessionSearchResult;
});
