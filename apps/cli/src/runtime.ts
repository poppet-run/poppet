import {
  AgentLive,
  ChatSettingsLive,
  ChatSettings,
  ModelResolver,
  NotesLive,
  PageTransportLive,
  PagesLive,
  SkillsLive,
  ProjectsLive,
} from "@poppet/agent";
import { AppConfig, makeAppConfigLive } from "@poppet/config";
import { ApiKeyStoreLive } from "@poppet/credentials";
import { GatewayRepositoryLive } from "@poppet/gateway";
import { makeMCPLive } from "@poppet/mcp";
import { LearnedSkillsLive, LocalMemoryLive } from "@poppet/memory";
import {
  Provider,
  ProviderEnvironment,
  ProviderConnection,
  ProviderId,
  invalidRequest,
  type ProviderRegistration,
  type ProviderError,
} from "@poppet/provider";
import { StoreLive } from "@poppet/store";
import { ChatTasksLive, TaskRepositoryLive, WorkerConnections } from "@poppet/tasks";
import { Context, Effect, Layer, Schema } from "effect";

import { createConnectionStatus } from "#src/connection-status";
import { ExternalAgentToolsLive } from "#src/mcp";
import { WebSearchLive } from "#src/web-search";

export const findProvider = (
  id: ProviderId,
  registered: ReadonlyArray<ProviderRegistration>,
): Effect.Effect<ProviderRegistration, ProviderError> => {
  const provider = registered.find((entry) => entry.id === id);

  return provider === undefined
    ? Effect.fail(invalidRequest(id, `Unknown provider ${id}. Choose a registered provider.`))
    : Effect.succeed(provider);
};

/** Wires registered providers and shared storage into the host's command and agent services. */
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
  const chatSettings = ChatSettingsLive.pipe(Layer.provide(config));

  const environment = Layer.effect(
    ProviderEnvironment,
    Effect.gen(function* () {
      const settings = yield* AppConfig;

      return { applicationName: settings.applicationName, dataDirectory: settings.dataDirectory };
    }),
  );

  const selectedProvider = (id: ProviderId) =>
    Layer.unwrap(findProvider(id, registered).pipe(Effect.map((entry) => entry.layer))).pipe(
      Layer.provide(environment),
    );

  const provider = Layer.unwrap(
    Effect.gen(function* () {
      const settings = yield* AppConfig;

      return selectedProvider(settings.provider);
    }),
  ).pipe(Layer.provideMerge(config));

  const resolveModel = Effect.gen(function* () {
    const settings = yield* AppConfig;

    if (settings.model === null)
      return yield* Effect.fail(
        invalidRequest(
          settings.provider,
          "Set model in config.json or POPPET_MODEL to a model from provider models.",
        ),
      );

    // The caller's scope keeps provider resources alive until inference finishes.
    const context = yield* Layer.build(selectedProvider(settings.provider));
    const model = yield* Context.get(context, Provider).resolve(settings.model);

    if (model.description.provider !== settings.provider || model.description.id !== settings.model)
      return yield* Effect.fail(
        invalidRequest(
          settings.provider,
          "The provider resolved a different model. No fallback is allowed.",
        ),
      );

    return model;
  });

  const store = StoreLive.pipe(Layer.provide(config));

  const memory = LocalMemoryLive.pipe(Layer.provide([store, config]));
  const learnedSkills = LearnedSkillsLive.pipe(Layer.provide(store));
  const skills = Layer.merge(SkillsLive, ProjectsLive).pipe(Layer.provide(config));
  const tasks = TaskRepositoryLive.pipe(Layer.provideMerge(store), Layer.provideMerge(skills));

  const connectionStatus = createConnectionStatus();

  const connections = Layer.effect(
    WorkerConnections,
    Effect.gen(function* () {
      const settings = yield* AppConfig;

      return {
        status: (id) =>
          Effect.scoped(
            ProviderConnection.use((connection) =>
              connection.status.pipe(
                Effect.flatMap((status) => connectionStatus.observe(id, status)),
              ),
            ).pipe(
              Effect.provide(selectedProvider(id)),
              Effect.provideService(AppConfig, settings),
            ),
          ).pipe(Effect.catch((error) => connectionStatus.fallback(id, error))),
      };
    }),
  ).pipe(Layer.provide(config));

  // Build inside the request scope so provider resources stay alive through streamed inference.
  const resolver = Layer.effect(
    ModelResolver,
    Effect.gen(function* () {
      const settings = yield* AppConfig;

      return {
        resolve: (providerId, modelId) =>
          Effect.gen(function* () {
            const context = yield* Layer.build(selectedProvider(providerId));

            yield* Context.get(context, ProviderConnection).status.pipe(
              Effect.flatMap((status) => connectionStatus.observe(providerId, status)),
              Effect.catch(() => Effect.void),
            );

            return yield* Context.get(context, Provider).resolve(modelId);
          }).pipe(Effect.provideService(AppConfig, settings)),
      };
    }),
  ).pipe(Layer.provide(config));

  const pages = PagesLive.pipe(Layer.provide([PageTransportLive, chatSettings]));
  const searchCredentials = ApiKeyStoreLive.pipe(Layer.provide(environment), Layer.provide(config));
  const webSearch = WebSearchLive.pipe(Layer.provide([config, chatSettings, searchCredentials]));
  const notes = NotesLive.pipe(Layer.provide([config, chatSettings]));
  const chatTasks = ChatTasksLive.pipe(Layer.provide([tasks, store, skills, chatSettings]));

  const mcp = Layer.unwrap(
    ChatSettings.pipe(Effect.map(({ toolBytes }) => makeMCPLive(toolBytes))),
  ).pipe(Layer.provide([config, chatSettings, searchCredentials]));

  const externalTools = ExternalAgentToolsLive.pipe(
    Layer.provideMerge(mcp),
    Layer.provide([config, chatSettings, tasks]),
  );

  const chat = AgentLive.pipe(
    Layer.provideMerge([
      store,
      skills,
      memory,
      learnedSkills,
      resolver,
      chatSettings,
      connections,
      pages,
      notes,
      webSearch,
      chatTasks,
      externalTools,
    ]),
    Layer.provideMerge(config),
  );

  return {
    config,
    chatSettings,
    provider,
    resolveModel,
    selectedProvider,
    store,
    memory,
    learnedSkills,
    tasks,
    skills,
    chat,
    connections,
    searchCredentials,
    mcp,
    messagingStatus: GatewayRepositoryLive.pipe(
      Layer.provideMerge(store),
      Layer.provideMerge(config),
    ),
  };
};
