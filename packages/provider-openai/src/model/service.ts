import {
  Provider,
  invalidRequest,
  verifyModel,
  type ModelDescription,
  type ModelOperations as SelectedModelOperations,
  type ProviderError,
  type ProviderOperations,
} from "@poppet/provider";
import { responsesModel } from "@poppet/provider-protocol";
import { Context, Effect, Layer, Schema } from "effect";

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

export type AvailableModel = (typeof ModelCatalog.Type.models)[number];

interface ModelOperations {
  readonly models: Effect.Effect<ReadonlyArray<AvailableModel>, ConnectionError>;
  readonly verify: (model: string | null) => Effect.Effect<string, ConnectionError>;
  readonly resolve: (model: string) => Effect.Effect<SelectedModelOperations, ProviderError>;
}

export class ChatGPTModel extends Context.Service<ChatGPTModel, ModelOperations>()(
  "poppet/ChatGPTModel",
) {}

export const makeChatGPTModel = (http: HttpFetch = fetch) =>
  Effect.gen(function* () {
    const auth = yield* ChatGPTAuth;

    const models = Effect.gen(function* () {
      const token = yield* auth.accessToken;

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
      return catalog.models.filter((model) => model.visibility === "list");
    });

    const verify = (requestedModel: string | null) =>
      Effect.gen(function* () {
        const catalog = yield* models;
        const model = requestedModel ?? catalog[0]?.slug;

        if (!model || !catalog.some((entry) => entry.slug === model))
          return yield* Effect.fail(
            new ConnectionError({
              reason: "unsupported",
              message: "Choose a model from bun run start auth models.",
            }),
          );
        const selected = yield* resolve(model).pipe(Effect.mapError(connectionFailure));
        yield* verifyModel(selected).pipe(Effect.mapError(connectionFailure));
        // Record success only after inference completes and the local tool result
        // comes back correctly. This confirms model access and tool handling.
        yield* auth.recordVerification(model);

        return model;
      });

    const resolve = (model: string) =>
      Effect.gen(function* () {
        const catalog = yield* models.pipe(Effect.mapError(providerFailure));
        const entry = catalog.find((candidate) => candidate.slug === model);

        if (!entry)
          return yield* Effect.fail(
            invalidRequest("openai-chatgpt", "Choose a model from the ChatGPT catalog."),
          );

        const client = auth.accessToken.pipe(
          Effect.map((token) => clientFor(token, http)),
          Effect.mapError(providerFailure),
        );

        return responsesModel(describeModel(entry), client, {
          failure: (cause) => inferenceFailure("openai-chatgpt", cause),
          remoteFailure: (status, code, requestId) =>
            remoteFailure("openai-chatgpt", status, code, requestId),
        });
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

export const makeChatGPTProvider = (http: HttpFetch = fetch) =>
  Effect.gen(function* () {
    const connection = yield* makeChatGPTModel(http);

    return {
      id: "openai-chatgpt",
      models: connection.models.pipe(
        Effect.map((models) => models.map(describeModel)),
        Effect.mapError(providerFailure),
      ),
      resolve: connection.resolve,
    } satisfies ProviderOperations;
  });

export const ChatGPTProviderLive = Layer.effect(Provider, makeChatGPTProvider());
