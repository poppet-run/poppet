import { Redacted, Schema } from "effect";

import { searchRequest } from "#src/web-search";

const BraveSearchResponse = Schema.Struct({
  grounding: Schema.Struct({
    generic: Schema.Array(
      Schema.Struct({
        title: Schema.NonEmptyString,
        url: Schema.String,
        snippets: Schema.Array(Schema.String),
      }),
    ),
  }),
});

/** Fixed endpoint and explicit redirect rejection keep the search key at Brave. */
export const makeBraveSearch = (
  key: Redacted.Redacted<string>,
  toolBytes: number,
  httpFetch: typeof fetch = fetch,
) => ({
  search: searchRequest(
    "Brave Search",
    (query, signal) => {
      const url = new URL("https://api.search.brave.com/res/v1/llm/context");
      url.search = new URLSearchParams({
        q: query,
        maximum_number_of_urls: "5",
        maximum_number_of_tokens: "2048",
      }).toString();

      return httpFetch(url, {
        signal,
        redirect: "error",
        headers: { Accept: "application/json", "X-Subscription-Token": Redacted.value(key) },
      });
    },
    (text) => {
      const response = Schema.decodeUnknownSync(Schema.fromJsonString(BraveSearchResponse))(text);

      return response.grounding.generic.map(({ title, url, snippets }) => ({
        title,
        url,
        snippet: snippets.join("\n\n"),
      }));
    },
    toolBytes,
  ),
});

/** Brave's credential and environment key, alongside its constructor. */
export const braveSearch = {
  name: "Brave Search",
  credentialId: "brave-search",
  make: makeBraveSearch,
} as const;
