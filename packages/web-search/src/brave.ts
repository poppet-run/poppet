import { Redacted, Schema } from "effect";

import { searchRequest } from "#src/web-search";

const BraveSearchResponse = Schema.Struct({
  type: Schema.Literal("search"),
  web: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        results: Schema.Array(
          Schema.Struct({
            title: Schema.NonEmptyString,
            url: Schema.String,
            description: Schema.optionalKey(Schema.NullOr(Schema.String)),
          }),
        ),
      }),
    ),
  ),
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
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.search = new URLSearchParams({
        q: query,
        count: "5",
        result_filter: "web",
        text_decorations: "false",
      }).toString();

      return httpFetch(url, {
        signal,
        redirect: "error",
        headers: { Accept: "application/json", "X-Subscription-Token": Redacted.value(key) },
      });
    },
    (text) => {
      const response = Schema.decodeUnknownSync(Schema.fromJsonString(BraveSearchResponse))(text);

      return (response.web?.results ?? []).map(({ title, url, description }) => ({
        title,
        url,
        snippet: description ?? "",
      }));
    },
    toolBytes,
  ),
});
