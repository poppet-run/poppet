import {
  AgentLive,
  ChatSettingsLive,
  ChatSettings,
  ModelResolver,
  PageTransportLive,
  PagesLive,
  SkillsLive,
} from "@poppet/agent";
import { AppConfig, makeAppConfigLive } from "@poppet/config";
import { ApiKeyStoreLive } from "@poppet/credentials";
import { GatewayRepositoryLive, TaskDeliveriesLive } from "@poppet/gateway";
import { MCPSignInsLive, makeMCPLive } from "@poppet/mcp";
import { LocalMemoryLive } from "@poppet/memory";
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

import { BashLive } from "#src/bash";
import { ExternalAgentToolsLive } from "#src/commands/mcp/tools";
import { WebSearchLive } from "#src/commands/web/search";
import { createConnectionStatus } from "#src/connection-status";

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

  const store = StoreLive.pipe(Layer.provide(config));

  const memory = LocalMemoryLive.pipe(Layer.provide([store, config]));
  const skills = SkillsLive.pipe(Layer.provide(config));

  const tasks = Layer.mergeAll(TaskRepositoryLive, TaskDeliveriesLive).pipe(
    Layer.provideMerge(store),
    Layer.provideMerge(skills),
  );

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
  const chatTasks = ChatTasksLive.pipe(Layer.provide([tasks, store, skills, chatSettings]));

  const mcpSignIns = MCPSignInsLive.pipe(Layer.provide(environment), Layer.provide(config));

  const mcp = Layer.unwrap(
    ChatSettings.pipe(Effect.map(({ toolBytes }) => makeMCPLive(toolBytes))),
  ).pipe(Layer.provide([config, chatSettings, searchCredentials, mcpSignIns]));

  const externalTools = ExternalAgentToolsLive.pipe(
    Layer.provideMerge(mcp),
    Layer.provide([config, chatSettings, tasks]),
  );

  const chat = AgentLive.pipe(
    Layer.provideMerge([
      store,
      skills,
      memory,
      resolver,
      chatSettings,
      connections,
      pages,
      webSearch,
      chatTasks,
      externalTools,
      BashLive,
    ]),
    Layer.provideMerge(config),
  );

  return {
    config,
    chatSettings,
    selectedProvider,
    store,
    memory,
    tasks,
    skills,
    chat,
    connections,
    searchCredentials,
    mcpSignIns,
    mcp,
    messagingStatus: GatewayRepositoryLive.pipe(
      Layer.provideMerge(store),
      Layer.provideMerge(config),
    ),
  };
};
