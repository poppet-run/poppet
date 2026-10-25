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
  const results: Array<WebSearchResult["results"][number]> = [];
  let truncated = candidates.length > 5;

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

    const result = (title: string, snippet: string) => ({ title, url: url.href, snippet });

    const fits = (title: string, snippet: string) =>
      Buffer.byteLength(
        JSON.stringify({ results: [...results, result(title, snippet)], truncated: true }),
      ) <= limit;

    // Shorten the snippet first; a title is shortened only once the snippet is gone.
    const snippet = fitPrefix(candidate.snippet, (prefix) => fits(candidate.title, prefix));

    const title =
      snippet === null ? fitPrefix(candidate.title, (prefix) => fits(prefix, "")) : candidate.title;

    if (title === null || (snippet === null && title === "")) {
      truncated = true;
      continue;
    }

    if (title !== candidate.title || snippet !== candidate.snippet) truncated = true;
    results.push(result(title, snippet ?? ""));
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
