import { randomUUID } from "node:crypto";

import { clip } from "@poppet/io";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";

import { decodeInput } from "#src/errors";
import { SessionSearchMatch, SessionSearchQuery, type SessionSearchResult } from "#src/schema";
import { decodeRows } from "#src/sql";

export const MaxBytes = Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65536 }));

const overhead = 250;

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

  const marker = randomUUID();

  const rows = yield* sql`SELECT m.session_id, m.id AS message_id, s.title, m.created_at,
      json_extract(m.payload, '$.role') AS role,
      snippet(session_search, 0, ${marker}, ${marker}, '', 48) AS excerpt,
      length(CAST(session_search.text AS BLOB)) AS text_bytes
    FROM session_search JOIN messages AS m ON m.id = session_search.rowid
    JOIN sessions AS s ON s.id = m.session_id
    WHERE session_search MATCH ${terms.join(" AND ")}
    ORDER BY rank, m.id LIMIT ${limit + 1}`.pipe(
    decodeRows(Schema.Struct({ ...SessionSearchMatch.fields, textBytes: Schema.Natural })),
  );

  let truncated = rows.length > limit;

  const matches = rows
    .slice(0, limit)
    .map(({ sessionId, messageId, title, createdAt, role, excerpt: snippet, textBytes }) => {
      const [before = "", firstHit = "", ...rest] = snippet.split(marker);
      const after = rest.join("");
      const hitBytes = Buffer.byteLength(firstHit);

      let excerpt: string;

      if (hitBytes >= excerptBytes) excerpt = clip(firstHit, excerptBytes);
      else {
        const side = Math.floor((excerptBytes - hitBytes) / 2);
        const lead = [...clip([...before].toReversed().join(""), side)].toReversed().join("");
        excerpt = `${lead}${firstHit}${clip(after, side)}`;
      }

      truncated ||= Buffer.byteLength(excerpt) < textBytes;

      return { sessionId, messageId, title, createdAt, role, excerpt };
    });

  return { matches, truncated } satisfies SessionSearchResult;
});
