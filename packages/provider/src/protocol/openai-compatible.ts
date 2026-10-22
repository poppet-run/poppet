import { Effect, Redacted, Schema } from "effect";
import OpenAI, { APIError } from "openai";

import { type HttpFetch, type ProviderId, ProviderError, invalidRequest } from "#src/index";

export const openAIClient = (options: {
  readonly key: Redacted.Redacted<string>;
  readonly baseUrl: string;
  readonly http: HttpFetch;
  readonly headers?: Record<string, string>;
}) =>
  new OpenAI({
    apiKey: Redacted.value(options.key),
    baseURL: options.baseUrl,
    fetch: options.http,
    maxRetries: 0,
    logLevel: "off",
    timeout: 45_000,
    defaultHeaders: options.headers,
  });

export const fetchModelCatalog = <S extends Schema.Top>(options: {
  readonly provider: ProviderId;
  readonly label: string;
  readonly url: string;
  readonly http: HttpFetch;
  readonly headers: Record<string, string>;
  readonly schema: S;
  readonly failure: (cause: unknown) => ProviderError;
}) =>
  Effect.gen(function* () {
    // Keep the response body inside the fetch's cancellation boundary.
    const body = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await options.http(options.url, { signal, headers: options.headers });

        if (!response.ok) {
          await response.body?.cancel();
          throw new APIError(response.status, undefined, undefined, response.headers);
        }

        try {
          return await response.json();
        } catch {
          throw invalidRequest(
            options.provider,
            `${options.label} returned an invalid model catalog.`,
          );
        }
      },
      catch: options.failure,
    });

    return yield* Schema.decodeUnknownEffect(options.schema)(body).pipe(
      Effect.mapError(() =>
        invalidRequest(options.provider, `${options.label} returned an unsupported model catalog.`),
      ),
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(
          new ProviderError({
            provider: options.provider,
            reason: "temporary",
            message: `${options.label} model discovery timed out.`,
          }),
        ),
    }),
  );
