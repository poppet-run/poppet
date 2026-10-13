import { AppConfig, AppConfigLive } from "@poppet/config";
import { Model, Provider, invalidRequest, type ProviderId } from "@poppet/provider";
import {
  BrowserSignInLive,
  ChatGPTAuthLive,
  ChatGPTModelLive,
  ChatGPTProviderLive,
  CredentialStoreLive,
  OAuthClientLive,
} from "@poppet/provider-openai";
import { OpenCodeGoLive } from "@poppet/provider-opencode";
import { Effect, Layer } from "effect";

// Build independent services first, then supply them to the layers that need them.
const dependencies = Layer.mergeAll(AppConfigLive, OAuthClientLive, BrowserSignInLive);

// provideMerge supplies dependencies and keeps them available to later layers,
// so storage, authentication, and model operations share the same services.
const storage = CredentialStoreLive.pipe(Layer.provideMerge(dependencies));

const authentication = ChatGPTAuthLive.pipe(Layer.provideMerge(storage));

export const ChatGPTRuntime = ChatGPTModelLive.pipe(Layer.provideMerge(authentication));

const chatGPTProvider = ChatGPTProviderLive.pipe(Layer.provide(authentication));

export const selectProviderLayer = (
  provider: ProviderId,
  chatGPT = chatGPTProvider,
  openCode = OpenCodeGoLive,
) => (provider === "openai-chatgpt" ? chatGPT : openCode);

export const ProviderRuntime = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig;

    return selectProviderLayer(config.provider);
  }),
).pipe(Layer.provideMerge(AppConfigLive));

export const resolveConfiguredModel = Effect.gen(function* () {
  const config = yield* AppConfig;

  if (config.model === null)
    return yield* Effect.fail(
      invalidRequest(config.provider, "Set POPPET_MODEL to a model from provider models."),
    );

  const provider = yield* Provider;

  const model = yield* provider.resolve(config.model);

  if (model.description.provider !== config.provider || model.description.id !== config.model)
    return yield* Effect.fail(
      invalidRequest(
        config.provider,
        "The provider resolved a different model. No fallback is allowed.",
      ),
    );

  return model;
});

export const SelectedModelRuntime = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig;

    if (config.model === null)
      return yield* Effect.fail(
        invalidRequest(config.provider, "Set POPPET_MODEL to a model from provider models."),
      );

    return Layer.effect(Model, resolveConfiguredModel).pipe(Layer.provideMerge(ProviderRuntime));
  }),
).pipe(Layer.provide(AppConfigLive));
