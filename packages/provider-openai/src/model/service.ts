import { Context, Effect, Layer, Schema } from "effect";

import { ChatGPTAuth } from "../auth/service.ts";
import { ConnectionError } from "../connection.ts";
import type { HttpFetch } from "../oauth/http.ts";
import { clientFor, modelFailure } from "./client.ts";
import { verifySubscription } from "./verification.ts";

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
        const token = yield* auth.accessToken;
        const client = clientFor(token, http);
        yield* verifySubscription(client, model);
        // Record success only after inference completes and the local tool result
        // comes back correctly. This confirms model access and tool handling.
        yield* auth.recordVerification(model);

        return model;
      });

    return { models, verify } satisfies ModelOperations;
  });

export const ChatGPTModelLive = Layer.effect(ChatGPTModel, makeChatGPTModel());
