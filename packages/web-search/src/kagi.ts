import { Redacted, Schema } from "effect";

import { searchRequest } from "#src/web-search";

const KagiSearchResponse = Schema.Struct({
  data: Schema.Struct({
    search: Schema.Array(
      Schema.Struct({
        title: Schema.NonEmptyString,
        url: Schema.String,
        snippet: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
});

/** Fixed endpoint and explicit redirect rejection keep the search key at Kagi. */
export const makeKagiSearch = (
  key: Redacted.Redacted<string>,
  toolBytes: number,
  httpFetch: typeof fetch = fetch,
) => ({
  search: searchRequest(
    "Kagi Search",
    (query, signal) =>
      httpFetch("https://kagi.com/api/v1/search", {
        method: "POST",
        signal,
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${Redacted.value(key)}`,
        },
        body: JSON.stringify({ query, workflow: "search", format: "json" }),
      }),
    (text) => {
      const response = Schema.decodeUnknownSync(Schema.fromJsonString(KagiSearchResponse))(text);

      return response.data.search.map(({ title, url, snippet }) => ({
        title,
        url,
        snippet: snippet ?? "",
      }));
    },
    toolBytes,
  ),
});

/** Kagi's credential and environment key, alongside its constructor. */
export const kagiSearch = {
  name: "Kagi Search",
  credentialId: "kagi-search",
  make: makeKagiSearch,
} as const;
