import { randomUUID } from "node:crypto";

import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";

import { decodeInput } from "#src/errors";
import { SessionSearchMatch, SessionSearchQuery, type SessionSearchResult } from "#src/schema";
import { decodeRows } from "#src/sql";

/** Bounds a caller-supplied JSON byte budget. */
export const MaxBytes = Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65536 }));

// Approximate JSON bytes a result spends on IDs, title, and field names.
const overhead = 250;

/** Cuts text to at most `bytes` UTF-8 bytes without splitting a character. */
export const clip = (text: string, bytes: number) => {
  let used = 0;
  let end = 0;

  for (const character of text) {
    used += Buffer.byteLength(character);

    if (used > bytes) break;
    end += character.length;
  }

  return text.slice(0, end);
};

/**
 * Searches completed exchanges. The budget sets how many matches return and how long
 * each excerpt is; results stay close to it but are not fitted exactly.
 */
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

  const limit = Math.min(10, Math.max(1, Math.floor(maxBytes / 400)));
  const excerptBytes = Math.min(4000, Math.floor(maxBytes / limit) - overhead);

  // snippet() centres each excerpt on its match; a fresh marker locates the match safely.
  const marker = randomUUID();

  const rows = yield* sql`SELECT m.session_id, m.id AS message_id, s.title, m.created_at,
      json_extract(m.payload, '$.role') AS role,
      snippet(session_search, 0, ${marker}, ${marker}, '', 48) AS excerpt,
      length(session_search.text) AS text_length
    FROM session_search JOIN messages AS m ON m.id = session_search.rowid
    JOIN sessions AS s ON s.id = m.session_id
    WHERE session_search MATCH ${terms.join(" AND ")}
    ORDER BY rank, m.id LIMIT ${limit + 1}`.pipe(
    decodeRows(Schema.Struct({ ...SessionSearchMatch.fields, textLength: Schema.Natural })),
  );

  let truncated = rows.length > limit;

  const matches = rows.slice(0, limit).map(({ textLength, ...row }) => {
    const [before = "", hit = "", after = ""] = row.excerpt.split(marker);
    // Keep the match and spend the remaining bytes evenly on either side of it.
    const side = Math.max(0, Math.floor((excerptBytes - Buffer.byteLength(hit)) / 2));
    const lead = [...clip([...before].toReversed().join(""), side)].toReversed().join("");
    const excerpt = `${lead}${hit}${clip(after, side)}`;

    truncated ||= excerpt.length < textLength;

    return { ...row, excerpt };
  });

  return { matches, truncated } satisfies SessionSearchResult;
});
