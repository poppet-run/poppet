import { AgentLive, ChatSettingsLive, ModelResolver, NotesLive } from "@poppet/agent";
import { AppConfig, makeAppConfigLive } from "@poppet/config";
import { LocalMemoryLive } from "@poppet/memory";
import {
  Model,
  Provider,
  ProviderEnvironment,
  ProviderId,
  invalidRequest,
  type ProviderRegistration,
  type ProviderError,
} from "@poppet/provider";
import { StoreLive } from "@poppet/store";
import { Context, Effect, Layer, Schema } from "effect";

import { providers } from "#src/providers";

export const findProvider = (
  id: ProviderId,
  registered: ReadonlyArray<ProviderRegistration>,
): Effect.Effect<ProviderRegistration, ProviderError> => {
  const provider = registered.find((entry) => entry.id === id);

  return provider === undefined
    ? Effect.fail(invalidRequest(id, `Unknown provider ${id}. Choose a registered provider.`))
    : Effect.succeed(provider);
};

export const selectProviderLayer = (id: ProviderId, registered = providers) =>
  Layer.unwrap(findProvider(id, registered).pipe(Effect.map((entry) => entry.layer)));

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

export const runtimeLayers = (registered: ReadonlyArray<ProviderRegistration>) => {
  const first = registered[0];

  if (first === undefined) throw new Error("Register at least one provider.");
  const ids = new Set<ProviderId>();

  for (const entry of registered) {
    Schema.decodeUnknownSync(ProviderId)(entry.id);

    if (ids.has(entry.id)) throw new Error(`Duplicate provider registration: ${entry.id}`);
    ids.add(entry.id);
  }

  const config = makeAppConfigLive(first.id, [...ids]);

  const environment = Layer.effect(
    ProviderEnvironment,
    Effect.gen(function* () {
      const settings = yield* AppConfig;

      return { applicationName: settings.applicationName, dataDirectory: settings.dataDirectory };
    }),
  );

  const selectedProvider = (id: ProviderId) =>
    selectProviderLayer(id, registered).pipe(Layer.provide(environment), Layer.provide(config));

  const provider = Layer.unwrap(
    Effect.gen(function* () {
      const settings = yield* AppConfig;

      return selectedProvider(settings.provider);
    }),
  ).pipe(Layer.provideMerge(config));

  const model = Layer.unwrap(
    Effect.gen(function* () {
      const settings = yield* AppConfig;

      if (settings.model === null)
        return yield* Effect.fail(
          invalidRequest(settings.provider, "Set POPPET_MODEL to a model from provider models."),
        );

      return Layer.effect(Model, resolveConfiguredModel).pipe(Layer.provideMerge(provider));
    }),
  ).pipe(Layer.provide(config));

  const store = StoreLive.pipe(Layer.provide(config));

  const memory = LocalMemoryLive.pipe(Layer.provide(Layer.merge(store, config)));

  const resolver = Layer.succeed(ModelResolver, {
    resolve: (providerId, modelId) =>
      Effect.gen(function* () {
        const context = yield* Layer.build(selectedProvider(providerId));

        return yield* Context.get(context, Provider).resolve(modelId);
      }).pipe(
        Effect.catchTag("ConfigError", () =>
          Effect.fail(invalidRequest(providerId, "Could not load the provider configuration.")),
        ),
      ),
  });

  const chat = AgentLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        store,
        memory,
        resolver,
        ChatSettingsLive,
        NotesLive.pipe(Layer.provide(Layer.merge(config, ChatSettingsLive))),
      ),
    ),
    Layer.provideMerge(config),
  );

  return {
    config,
    provider,
    model,
    selectedProvider,
    store,
    memory,
    chat,
  };
};
