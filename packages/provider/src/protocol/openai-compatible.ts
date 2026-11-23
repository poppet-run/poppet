import { Clock, Effect, Redacted, Schema, Semaphore } from "effect";
import OpenAI, { APIError } from "openai";

import { ProviderError, invalidRequest, measureTiming } from "#src/index";
import type { HttpFetch, ProviderId } from "#src/index";

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
    const body = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await options.http(options.url, { signal, headers: options.headers });

        if (!response.ok) {
          await response.body?.cancel();
          throw new APIError(response.status, undefined, undefined, response.headers);
        }

        try {
          return await response.json();
        } catch (cause) {
          if (!(cause instanceof SyntaxError)) throw cause;

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

export const createCatalogCache = <A extends { readonly id: string }>(ttlMs = 60_000) => {
  type Entry = { readonly expiresAt: number; readonly models: ReadonlyArray<A> };

  type Slot = { readonly lock: Semaphore.Semaphore; entry: Entry | null };

  const caches = new WeakMap<HttpFetch, Map<string, Slot>>();

  return (options: {
    readonly http: HttpFetch;
    readonly key: string;
    readonly load: Effect.Effect<ReadonlyArray<A>, ProviderError>;
  }) => {
    let perKey = caches.get(options.http);

    if (perKey === undefined) {
      perKey = new Map();
      caches.set(options.http, perKey);
    }

    let slot = perKey.get(options.key);

    if (slot === undefined) {
      if (perKey.size >= 32) perKey.delete(perKey.keys().next().value!);
      slot = { lock: Semaphore.makeUnsafe(1), entry: null };
      perKey.set(options.key, slot);
    }

    const active = slot;

    return (requested?: string): Effect.Effect<ReadonlyArray<A>, ProviderError> =>
      active.lock.withPermit(
        Effect.gen(function* () {
          const entry = active.entry;
          const now = yield* Clock.currentTimeMillis;

          if (
            requested !== undefined &&
            entry !== null &&
            entry.expiresAt > now &&
            entry.models.some((model) => model.id === requested)
          )
            return yield* measureTiming("model-catalog", Effect.succeed(entry.models), {
              cached: true,
            });

          active.entry = null;

          return yield* measureTiming(
            "model-catalog",
            Effect.gen(function* () {
              const models = yield* options.load;
              active.entry = {
                expiresAt: (yield* Clock.currentTimeMillis) + ttlMs,
                models,
              };

              return models;
            }),
            { cached: false },
          );
        }),
      );
  };
};
