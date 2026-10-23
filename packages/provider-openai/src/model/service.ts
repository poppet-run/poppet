import { createHash } from "node:crypto";

import {
  Provider,
  invalidRequest,
  measureTiming,
  verifyModel,
  type ModelDescription,
  type ModelOperations as SelectedModelOperations,
  type ProviderError,
  type ProviderOperations,
} from "@poppet/provider";
import { responsesModel } from "@poppet/provider/protocol";
import { Clock, Context, Effect, Layer, Redacted, Schema, Semaphore } from "effect";

import { ChatGPTAuth } from "#src/auth/service";
import { ConnectionError } from "#src/connection";
import { clientFor, modelFailure } from "#src/model/client";
import { connectionFailure, providerFailure } from "#src/model/errors";
import { inferenceFailure, remoteFailure } from "#src/model/errors";
import type { HttpFetch } from "#src/oauth/http";

const ModelCatalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.NonEmptyString,
      display_name: Schema.NonEmptyString,
      visibility: Schema.String,
    }),
  ),
});

/** An account-catalog entry before translation into the shared model description. */
export type AvailableModel = (typeof ModelCatalog.Type.models)[number];

interface CatalogCache {
  readonly lock: Semaphore.Semaphore;
  entry: {
    readonly credential: string;
    readonly expiresAt: number;
    readonly models: ReadonlyArray<AvailableModel>;
  } | null;
}

// Provider layers are rebuilt per request; retain only one credential-bound entry per transport.
const catalogs = new WeakMap<HttpFetch, CatalogCache>();

interface ModelOperations {
  readonly models: Effect.Effect<ReadonlyArray<AvailableModel>, ConnectionError>;
  readonly verify: (model: string | null) => Effect.Effect<string, ConnectionError>;
  readonly resolve: (model: string) => Effect.Effect<SelectedModelOperations, ProviderError>;
}

/** Lists, verifies, and resolves models available through the current ChatGPT connection. */
export class ChatGPTModel extends Context.Service<ChatGPTModel, ModelOperations>()(
  "poppet/ChatGPTModel",
) {}

export const makeChatGPTModel = (http: HttpFetch = fetch) =>
  Effect.gen(function* () {
    const auth = yield* ChatGPTAuth;
    let cache = catalogs.get(http);

    if (cache === undefined) {
      cache = { lock: Semaphore.makeUnsafe(1), entry: null };
      catalogs.set(http, cache);
    }

    const catalogCache = cache;

    const readCatalog = (requested?: string) =>
      Effect.gen(function* () {
        const token = yield* auth.accessToken;
        const credential = createHash("sha256").update(Redacted.value(token)).digest("hex");

        return yield* catalogCache.lock.withPermit(
          Effect.gen(function* () {
            const entry = catalogCache.entry;
            const now = yield* Clock.currentTimeMillis;

            if (
              requested !== undefined &&
              entry?.credential === credential &&
              entry.expiresAt > now &&
              entry.models.some((model) => model.slug === requested)
            )
              return yield* measureTiming("model-catalog", Effect.succeed(entry.models), {
                cached: true,
              });

            catalogCache.entry = null;

            return yield* measureTiming(
              "model-catalog",
              Effect.gen(function* () {
                const body = yield* Effect.tryPromise({
                  try: (signal) => clientFor(token, http).get("/models", { signal }),
                  catch: modelFailure,
                });

                const catalog = yield* Schema.decodeUnknownEffect(ModelCatalog)(body).pipe(
                  Effect.mapError(
                    () =>
                      new ConnectionError({
                        reason: "unsupported",
                        message: "OpenAI returned an unsupported model catalog.",
                      }),
                  ),
                );

                // Offer only models the account catalog marks as visible to the user.
                const models = catalog.models.filter((model) => model.visibility === "list");
                catalogCache.entry = {
                  credential,
                  expiresAt: (yield* Clock.currentTimeMillis) + 60_000,
                  models,
                };

                return models;
              }),
              { cached: false },
            );
          }),
        );
      });

    const models = readCatalog();

    const selectedModel = (entry: AvailableModel) =>
      responsesModel(
        describeModel(entry),
        auth.accessToken.pipe(
          Effect.map((token) => clientFor(token, http)),
          Effect.mapError(providerFailure),
        ),
        {
          failure: (cause) => inferenceFailure("openai-chatgpt", cause),
          remoteFailure: (status, code, requestId) =>
            remoteFailure("openai-chatgpt", status, code, requestId),
        },
      );

    const verify = (requestedModel: string | null) =>
      Effect.gen(function* () {
        const catalog = yield* models;

        const entry =
          requestedModel === null
            ? catalog[0]
            : catalog.find((model) => model.slug === requestedModel);

        if (!entry)
          return yield* Effect.fail(
            new ConnectionError({
              reason: "unsupported",
              message: "Choose a model from poppet provider models.",
            }),
          );
        yield* verifyModel(selectedModel(entry)).pipe(Effect.mapError(connectionFailure));
        // Record success only after inference completes and the local tool result
        // comes back correctly. This confirms model access and tool handling.
        yield* auth.recordVerification(entry.slug);

        return entry.slug;
      });

    const resolve = (model: string) =>
      Effect.gen(function* () {
        const catalog = yield* readCatalog(model).pipe(Effect.mapError(providerFailure));
        const entry = catalog.find((candidate) => candidate.slug === model);

        if (!entry)
          return yield* Effect.fail(
            invalidRequest("openai-chatgpt", "Choose a model from the ChatGPT catalog."),
          );

        return selectedModel(entry);
      });

    return { models, verify, resolve } satisfies ModelOperations;
  });

export const ChatGPTModelLive = Layer.effect(ChatGPTModel, makeChatGPTModel());

const describeModel = (model: AvailableModel): ModelDescription => ({
  provider: "openai-chatgpt",
  id: model.slug,
  name: model.display_name,
  capabilities: { tools: true, generationSettings: [], contextWindow: null, maxOutputTokens: null },
});

export const makeChatGPTProvider = (connection: ChatGPTModel["Service"]): ProviderOperations => ({
  id: "openai-chatgpt",
  models: connection.models.pipe(
    Effect.map((models) => models.map(describeModel)),
    Effect.mapError(providerFailure),
  ),
  resolve: connection.resolve,
});

export const ChatGPTProviderLive = Layer.effect(
  Provider,
  Effect.map(ChatGPTModel, makeChatGPTProvider),
).pipe(Layer.provide(ChatGPTModelLive));
