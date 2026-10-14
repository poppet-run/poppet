import { ProviderConnection, type ProviderRegistration } from "@poppet/provider";
import { Effect, Layer } from "effect";

import { CredentialStoreLive } from "#src/auth/credentials";
import { ChatGPTAuth, ChatGPTAuthLive } from "#src/auth/service";
import { providerFailure } from "#src/model/errors";
import { ChatGPTModel, ChatGPTModelLive, ChatGPTProviderLive } from "#src/model/service";
import { OAuthClientLive } from "#src/oauth/client";
import { BrowserSignInLive } from "#src/sign-in/service";

const storage = CredentialStoreLive.pipe(
  Layer.provideMerge(Layer.mergeAll(OAuthClientLive, BrowserSignInLive)),
);

const authentication = ChatGPTAuthLive.pipe(Layer.provideMerge(storage));

const models = ChatGPTModelLive.pipe(Layer.provideMerge(authentication));

const connection = Layer.effect(
  ProviderConnection,
  Effect.gen(function* () {
    const auth = yield* ChatGPTAuth;
    const model = yield* ChatGPTModel;

    return {
      login: (options) =>
        auth.login(options.consent).pipe(
          Effect.mapError(providerFailure),
          Effect.map((status) =>
            status.planUsage
              ? "Connected to ChatGPT. Plan usage is enabled; run auth verify --provider openai-chatgpt to check inference."
              : "Connected to ChatGPT. Plan usage was not granted; run auth login openai-chatgpt --consent to enable it.",
          ),
        ),
      status: auth.status.pipe(
        Effect.mapError(providerFailure),
        Effect.map((status) => ({ ...status })),
      ),
      logout: auth.signOut.pipe(
        Effect.mapError(providerFailure),
        Effect.map((revoked) =>
          revoked
            ? "Signed out. All local ChatGPT connection details were deleted, including identity, tokens, verification, registration, and host ID."
            : "All local ChatGPT connection details were deleted, but remote revocation was not confirmed. Disconnect Poppet in ChatGPT Settings.",
        ),
      ),
      verify: (modelId) => model.verify(modelId).pipe(Effect.mapError(providerFailure)),
    };
  }),
).pipe(Layer.provide(models));

export const chatGPT: ProviderRegistration = {
  id: "openai-chatgpt",
  name: "ChatGPT",
  authentication: {
    consent: true,
    apiKey: false,
    help: "Browser sign-in; --consent enables ChatGPT plan usage.",
  },
  layer: Layer.effectContext(
    Layer.build(
      Layer.merge(connection, ChatGPTProviderLive.pipe(Layer.provide(authentication))),
    ).pipe(Effect.mapError(providerFailure)),
  ),
};
