import type { HttpFetch } from "@poppet/provider";
import { Effect } from "effect";

import { ConnectionError } from "#src/connection";

export type { HttpFetch } from "@poppet/provider";

export const networkError = () =>
  new ConnectionError({
    reason: "temporary",
    message: "Could not contact OpenAI. Retry later; existing credentials were retained.",
  });

// The caller's scope owns the response body, including after fetch returns its headers.
export const request = (http: HttpFetch, url: string, init?: RequestInit) =>
  Effect.gen(function* () {
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (owned) => Effect.sync(() => owned.abort()),
    );

    return yield* Effect.tryPromise({
      // Reject redirects so requests stay on the endpoints validated during discovery.
      try: (signal) =>
        http(url, {
          ...init,
          signal: AbortSignal.any([signal, controller.signal]),
          redirect: "error",
        }),
      catch: networkError,
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () => Effect.fail(networkError()),
    }),
  );
