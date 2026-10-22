import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { Schema } from "effect";

import { readRecord } from "#src/errors";
import { SessionSearchMatch, SessionSearchQuery, type SessionSearchResult } from "#src/schema";

/** Searches completed exchanges and keeps excerpts around their match within the JSON byte budget. */
export const searchSessions = (
  database: Database,
  query: string,
  maxBytes: number,
  project?: string | null,
): SessionSearchResult => {
  const text = Schema.decodeUnknownSync(SessionSearchQuery)(query);
  Schema.decodeUnknownSync(Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65536 })))(
    maxBytes,
  );

  const terms = text
    .split(/\s+/u)
    .filter((term) => /[\p{L}\p{N}]/u.test(term))
    .map((term) => `"${term.replaceAll('"', '""')}"`);

  if (terms.length === 0) return { matches: [], truncated: false };

  // Use a fresh marker so stored text cannot be mistaken for a match boundary.
  const marker = randomUUID();

  const rows = readRecord(() =>
    Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          ...SessionSearchMatch.fields,
          textLength: Schema.Natural,
        }),
      ),
    )(
      database
        .query(`SELECT m.session_id AS sessionId, m.id AS messageId,
      s.title, m.created_at AS createdAt, json_extract(m.payload, '$.role') AS role,
      snippet(session_search, 0, ?, ?, '', 48) AS excerpt,
      length(session_search.text) AS textLength
      FROM session_search JOIN messages AS m ON m.id = session_search.rowid
      JOIN sessions AS s ON s.id = m.session_id
      WHERE session_search MATCH ? AND (? OR json_extract(s.project, '$.name') IS ?)
      ORDER BY rank, m.id LIMIT 11`)
        .all(marker, marker, terms.join(" AND "), project === undefined ? 1 : 0, project ?? null),
    ),
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
      if (length === hitLength) return { matches, truncated: true };
      length = Math.max(hitLength, Math.floor(length / 2));
      match = { ...row, excerpt: excerpt() };
      truncated = true;
    }

    matches.push(match);
  }

  return { matches, truncated };
};
