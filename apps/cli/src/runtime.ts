import { AgentLive, ChatSettingsLive, ModelResolver, NotesLive } from "@poppet/agent";
import { AppConfig, makeAppConfigLive } from "@poppet/config";
import { GatewayRepositoryLive } from "@poppet/gateway";
import { LocalMemoryLive } from "@poppet/memory";
import {
  Model,
  Provider,
  ProviderEnvironment,
  ProviderConnection,
  ProviderId,
  invalidRequest,
  type ProviderRegistration,
  ProviderError,
} from "@poppet/provider";
import { StoreLive } from "@poppet/store";
import { TaskRepositoryLive, WorkerConnections } from "@poppet/tasks";
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
  const tasks = TaskRepositoryLive.pipe(Layer.provideMerge(store));

  const observed = new Map<ProviderId, Schema.JsonObject>();

  const ConnectionMetadata = Schema.Struct({
    connected: Schema.Boolean,
    email: Schema.optionalKey(Schema.NullOr(Schema.String)),
    planUsage: Schema.optionalKey(Schema.Boolean),
    expiresAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    source: Schema.optionalKey(Schema.NullOr(Schema.String)),
  });

  const observeConnection = (id: ProviderId, status: Schema.JsonObject) =>
    Schema.decodeUnknownEffect(ConnectionMetadata)(status).pipe(
      Effect.map((metadata): Schema.JsonObject => {
        const snapshot = {
          provider: id,
          account: metadata.email ?? null,
          connected: metadata.connected,
          planUsage: metadata.planUsage ?? null,
          expiresAt: metadata.expiresAt ?? null,
          source: metadata.source ?? null,
          observedAt: Date.now(),
          cached: false,
          action: !metadata.connected
            ? `Run auth login ${id}.`
            : metadata.planUsage === false
              ? `Run auth login ${id} --consent.`
              : null,
        };

        observed.set(id, snapshot);

        return snapshot;
      }),
      Effect.mapError(() => invalidRequest(id, "The provider returned invalid connection status.")),
    );

  const connections = Layer.succeed(WorkerConnections, {
    status: (id) =>
      Effect.scoped(
        ProviderConnection.use((connection) =>
          connection.status.pipe(Effect.flatMap((status) => observeConnection(id, status))),
        ).pipe(Effect.provide(selectedProvider(id))),
      ).pipe(
        Effect.catch((error): Effect.Effect<Schema.JsonObject> => {
          const cached = observed.get(id);

          if (
            error instanceof ProviderError &&
            error.code === "credential_store_busy" &&
            cached !== undefined
          )
            return Effect.succeed({ ...cached, cached: true });

          return Effect.succeed({
            provider: id,
            connected: null,
            account: null,
            planUsage: null,
            action:
              error instanceof ProviderError && error.code === "credential_store_busy"
                ? "Authentication is busy. Check again after the active run finishes."
                : `Run auth status ${id} to inspect the connection.`,
          } satisfies Schema.JsonObject);
        }),
      ),
  });

  const resolver = Layer.succeed(ModelResolver, {
    resolve: (providerId, modelId) =>
      Effect.gen(function* () {
        const context = yield* Layer.build(selectedProvider(providerId));

        yield* Context.get(context, ProviderConnection).status.pipe(
          Effect.flatMap((status) => observeConnection(providerId, status)),
          Effect.catch(() => Effect.void),
        );

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
        connections,
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
    tasks,
    chat,
    connections,
    messagingStatus: GatewayRepositoryLive.pipe(
      Layer.provideMerge(store),
      Layer.provideMerge(config),
    ),
  };
};
