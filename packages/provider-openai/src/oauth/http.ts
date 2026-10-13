import { Effect } from "effect";

import { ConnectionError } from "../connection.ts";

export type HttpFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const networkError = () =>
  new ConnectionError({
    reason: "temporary",
    message: "Could not contact OpenAI. Retry later; existing credentials were retained.",
  });

// Pass Effect's AbortSignal to fetch so interruption and deadlines cancel I/O.
// Reject redirects so requests stay on the endpoints validated during discovery.
export const request = (http: HttpFetch, url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: (signal) => http(url, { ...init, signal, redirect: "error" }),
    catch: networkError,
  }).pipe(
    Effect.timeout("20 seconds"),
    Effect.catchTag("TimeoutError", () => Effect.fail(networkError())),
  );
