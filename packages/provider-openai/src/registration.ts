import { readCredentialFile } from "@poppet/credentials";
import {
  CredentialInput,
  ProviderConnection,
  ProviderError,
  type ProviderRegistration,
} from "@poppet/provider";
import { Effect, Layer, Schema } from "effect";

import { CredentialStoreLive } from "#src/auth/credentials";
import { ChatGPTAuth, ChatGPTAuthLive } from "#src/auth/service";
import { Connection, ConnectionError } from "#src/connection";
import { providerFailure } from "#src/model/errors";
import { ChatGPTModel, ChatGPTModelLive, ChatGPTProviderLive } from "#src/model/service";
import { OAuthClientLive } from "#src/oauth/client";
import { BrowserSignInLive } from "#src/sign-in/service";

const storage = CredentialStoreLive.pipe(Layer.provideMerge([OAuthClientLive, BrowserSignInLive]));

const authentication = ChatGPTAuthLive.pipe(Layer.provideMerge(storage));

const models = ChatGPTModelLive.pipe(Layer.provideMerge(authentication));

const connection = Layer.effect(
  ProviderConnection,
  Effect.gen(function* () {
    const auth = yield* ChatGPTAuth;
    const model = yield* ChatGPTModel;

    return {
      login: (options) =>
        Effect.gen(function* () {
          const input = yield* CredentialInput;

          return yield* auth.login({
            noBrowser: !options.openBrowser,
            callbackPort: options.callbackPort,
            paste: input
              .readLine("openai-chatgpt", "Callback URL: ")
              .pipe(
                Effect.mapError(
                  (error) => new ConnectionError({ reason: "callback", message: error.message }),
                ),
              ),
          });
        }).pipe(
          Effect.mapError(providerFailure),
          Effect.map((status) =>
            status.planUsage
              ? "Connected to ChatGPT. Plan usage is enabled."
              : "Connected to ChatGPT. Plan usage was not granted; run provider login openai-chatgpt to enable it.",
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
    apiKey: false,
    help: "Browser sign-in with ChatGPT plan-usage consent. Over SSH or with --no-browser, finish in any browser and paste the callback address.",
  },
  inspectSaved: (directory) =>
    Effect.gen(function* () {
      const text = yield* Effect.tryPromise(() => readCredentialFile(directory, "connection.json"));

      if (text === null) return { connected: false, expiresAt: null, source: "saved" as const };
      const saved = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Connection))(text);

      return {
        connected:
          saved.clientId !== null &&
          saved.identity !== null &&
          saved.credentials !== null &&
          saved.credentials.scopes.includes("chatgpt.tokens.use.direct") &&
          (saved.credentials.accessToken !== null || saved.credentials.refreshToken !== null),
        expiresAt: saved.credentials?.expiresAt ?? null,
        source: "saved" as const,
      };
    }).pipe(
      Effect.mapError(
        () =>
          new ProviderError({
            provider: "openai-chatgpt",
            reason: "authentication",
            message: "Cannot inspect saved ChatGPT credentials.",
          }),
      ),
    ),
  layer: Layer.effectContext(
    Layer.build(
      Layer.merge(connection, ChatGPTProviderLive.pipe(Layer.provide(authentication))),
    ).pipe(Effect.mapError(providerFailure)),
  ),
};
