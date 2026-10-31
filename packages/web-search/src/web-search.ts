import { isIP } from "node:net";

import { fitPrefix, readBoundedText, publicHttpURL, urlHostname, publicAddress } from "@poppet/io";
import { Context, Effect } from "effect";

import { WebSearchError } from "#src/errors";

export interface WebSearchResult {
  readonly results: ReadonlyArray<{
    readonly title: string;
    readonly url: string;
    readonly snippet: string;
  }>;
  readonly truncated: boolean;
}

/** Null search means disabled or missing credentials; no tool is advertised. */
export class WebSearch extends Context.Service<
  WebSearch,
  {
    readonly search: ((query: string) => Effect.Effect<WebSearchResult, WebSearchError>) | null;
  }
>()("poppet/WebSearch") {}

/** Keep source URLs intact; only results visible in this budget can grant page access. */
export const webSearchResult = (
  candidates: WebSearchResult["results"],
  limit: number,
): WebSearchResult => {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const sources: Array<WebSearchResult["results"][number]> = [];
  let truncated = candidates.length > 5;
  // Reserve the longer boolean representation so an untruncated result also fits.
  const size = () => Buffer.byteLength(JSON.stringify({ results, truncated: false }));

  for (const candidate of candidates.slice(0, 5)) {
    let url: URL;

    try {
      url = publicHttpURL(candidate.url, () => new Error("Invalid source URL"));
      const hostname = urlHostname(url);

      if (isIP(hostname) && !publicAddress(hostname)) throw new Error("Non-public address");
    } catch {
      truncated = true;
      continue;
    }

    // Reserve source URLs before spending any space on titles or passages.
    results.push({ title: "", url: url.href, snippet: "" });

    if (size() > limit) {
      results.pop();
      truncated = true;
      continue;
    }

    sources.push(candidate);
  }

  for (const field of ["title", "snippet"] as const) {
    // Fill short fields first, sharing their unused allocation among longer ones.
    const pending = sources
      .map((source, index) => ({ text: source[field], index }))
      .toSorted(
        (a, b) =>
          Buffer.byteLength(JSON.stringify(a.text)) - Buffer.byteLength(JSON.stringify(b.text)),
      );

    for (const [position, { text, index }] of pending.entries()) {
      const allowance = Math.floor((limit - size()) / (pending.length - position));

      const prefix =
        fitPrefix(text, (value) => Buffer.byteLength(JSON.stringify(value)) - 2 <= allowance) ?? "";

      results[index]![field] = prefix;

      if (prefix !== text) truncated = true;
    }
  }

  return { results, truncated };
};

/** Providers supply fixed endpoints and map validated responses into common source results. */
export const searchRequest = (
  provider: string,
  request: (query: string, signal: AbortSignal) => Promise<Response>,
  decode: (text: string) => WebSearchResult["results"],
  toolBytes: number,
): NonNullable<WebSearch["Service"]["search"]> => {
  const searchFailure = () =>
    new WebSearchError({ reason: "tool-network", message: `Could not search ${provider}.` });

  return (query) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await request(query, signal);

        try {
          if (!response.ok)
            throw new WebSearchError({
              reason:
                response.status === 401 || response.status === 403
                  ? "tool-authentication"
                  : response.status === 429
                    ? "tool-rate-limit"
                    : "tool-network",
              message: `${provider} returned HTTP ${response.status}.`,
            });

          if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? ""))
            throw searchFailure();

          if (response.body === null) throw searchFailure();

          const text = await readBoundedText(
            response.body,
            1048576,
            () =>
              new WebSearchError({
                reason: "tool-limit",
                message: "The search response exceeds the 1 MiB body limit.",
              }),
          );

          return webSearchResult(decode(text), toolBytes);
        } finally {
          await response.body?.cancel().catch(() => undefined);
        }
      },
      catch: (cause) => (cause instanceof WebSearchError ? cause : searchFailure()),
    }).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () =>
          Effect.fail(
            new WebSearchError({
              reason: "tool-network",
              message: "The search request exceeded its 15-second deadline.",
            }),
          ),
      }),
    );
};
