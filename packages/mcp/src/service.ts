import { InsufficientScopeError, type FetchLike } from "@modelcontextprotocol/client";
import { ApiKeyStore } from "@poppet/credentials";
import { Clock, Context, Effect, Layer, Ref, Semaphore } from "effect";

import { containsSecret } from "#src/catalog";
import { isHTTPServer, mcpServers, type MCPServer } from "#src/config";
import {
  closeConnection,
  diagnostic,
  discoverTools,
  failed,
  fetchHTTP,
  hydrateConnection,
  invalidateConnection,
  listTools,
  logDiagnostic,
  openConnectionResources,
  requireLogin,
  retryAt,
  startupFailure,
  type Connection,
  type ConnectionState,
} from "#src/connection";
import { MCPError } from "#src/errors";
import { isOAuthServer, MCPSignIns, signInStatus } from "#src/oauth";
import { buildTools, type MCPTool } from "#src/tools";
import { ReviewedAccountChanged, ScopedStdioTransport } from "#src/transport";

export type { MCPTool } from "#src/tools";

export class MCP extends Context.Service<
  MCP,
  {
    readonly status: Effect.Effect<
      ReadonlyArray<{
        readonly id: string;
        readonly enabled: boolean;
        readonly state: ConnectionState["status"];
        readonly transport: "stdio" | "http";
        readonly origin: string | null;
        readonly pid: number | null;
        readonly diagnostic: string | null;
        readonly retryAt: number | null;
        readonly tools: ReadonlyArray<string>;
        readonly scheduledTools: ReadonlyArray<string>;
        readonly scheduledReviewedTools: ReadonlyArray<string>;
        readonly availableTools: ReadonlyArray<string>;
        readonly signIn: {
          readonly signedIn: boolean;
          readonly expiresAt: number | null;
          readonly scopes: ReadonlyArray<string>;
        } | null;
      }>
    >;
    readonly snapshot: (scheduled: boolean) => Effect.Effect<ReadonlyArray<MCPTool>, MCPError>;
    readonly tools: (id: string) => Effect.Effect<
      ReadonlyArray<{
        readonly serverId: string;
        readonly toolName: string;
        readonly definition: MCPTool["definition"] | null;
        readonly allowed: boolean;
        readonly scheduled: boolean;
        readonly scheduledReviewed: boolean;
        readonly reviewed: boolean;
      }>,
      MCPError
    >;
  }
>()("poppet/MCP") {}

export const makeMCPLive = (toolBytes: number) =>
  Layer.effect(
    MCP,
    Effect.gen(function* () {
      const servers = yield* mcpServers;
      const credentials = yield* ApiKeyStore;
      const signIns = yield* MCPSignIns;
      const locks = new Map(servers.map((config) => [config.id, Semaphore.makeUnsafe(1)]));
      const clock = yield* Clock.Clock;
      const now = () => clock.currentTimeMillisUnsafe();
      const connections = new Map<string, Connection<MCPTool>>();
      const run = Effect.runPromiseWith(yield* Effect.context());

      yield* Effect.addFinalizer(() =>
        Effect.promise(() => Promise.allSettled([...connections.values()].map(closeConnection))),
      );

      const connect = (config: MCPServer) =>
        Effect.gen(function* () {
          const prior = connections.get(config.id);
          let retries = 0;

          if (prior !== undefined) {
            const state = Ref.getUnsafe(prior.state);

            if (
              state.status !== "needs-login" &&
              (state.status !== "unavailable" || clock.currentTimeMillisUnsafe() < retryAt(state))
            )
              return prior;
            yield* Effect.promise(() => closeConnection(prior).catch(() => {}));
            connections.delete(config.id);
            retries = state.status === "unavailable" ? state.retries + 1 : 0;
          }

          const resources = openConnectionResources(config);
          const missing = { value: false };
          const oauth = isHTTPServer(config) && isOAuthServer(config) ? config : null;

          const connection: Connection<MCPTool> = {
            client: resources.client,
            transport: resources.transport,
            now,
            logCloseFailure: () => run(logDiagnostic(config.id, "Transport cleanup failed.")),
            token: () => resources.authorization.current?.token(),
            state: Ref.makeUnsafe<ConnectionState<MCPTool>>(
              config.enabled ? { status: "idle", retries } : { status: "disabled" },
            ),
            closing: null,
            signIn:
              oauth === null
                ? null
                : {
                    required: () =>
                      missing.value || resources.authorization.current?.loginRequired() === true,
                    message: `MCP ${config.id}: sign-in required. Run poppet mcp login ${config.id}.`,
                  },
          };

          const disconnected = () => {
            void invalidateConnection(
              connection,
              Ref.getUnsafe(connection.state).status === "idle"
                ? `${startupFailure(config, null).message} Poppet retries on a later request.`
                : `MCP ${config.id}: disconnected or invalid protocol. Dispatched calls may have unknown effects; Poppet reconnects on a later request.`,
            ).catch(() => {});
          };

          resources.client.onclose = disconnected;
          resources.client.onerror = (error) => {
            if (
              !(error instanceof ReviewedAccountChanged || error instanceof InsufficientScopeError)
            )
              disconnected();
          };

          connections.set(config.id, connection);

          if (!config.enabled) return connection;

          const startup = Effect.gen(function* () {
            const current = yield* hydrateConnection(
              config,
              resources,
              credentials,
              signIns,
              now,
              () => {
                missing.value = true;
              },
            );

            const discovered = yield* Effect.tryPromise({
              try: async (signal) => {
                await resources.client.connect(resources.transport, { signal, timeout: 5000 });

                return discoverTools(config, resources.client, signal);
              },
              catch: (cause) => startupFailure(config, cause),
            });

            const { tools, skipped } = yield* buildTools(
              config,
              discovered,
              connection,
              current,
              toolBytes,
            );

            const currentState = Ref.getUnsafe(connection.state);

            if (currentState.status === "unavailable")
              return yield* Effect.fail(failed(currentState.diagnostic));

            if (discovered.some((tool) => containsSecret(tool.name, current())))
              return yield* Effect.fail(
                failed(`MCP ${config.id}: tool names contain credentials.`),
              );

            const skippedMessage =
              skipped.length === 0
                ? null
                : `MCP ${config.id}: skipped ${skipped.length} allowed ${skipped.length === 1 ? "tool" : "tools"}. ${skipped.join(" ")}`;

            yield* Ref.set(connection.state, {
              status: "connected",
              tools,
              discovered: discovered.map((tool) => tool.name),
              diagnostic: skippedMessage,
            });

            if (skippedMessage !== null) yield* logDiagnostic(config.id, skippedMessage);
          }).pipe(Effect.timeout("8 seconds"));

          yield* startup.pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* Effect.promise(() =>
                  invalidateConnection(
                    connection,
                    `${error instanceof MCPError ? error.message : `MCP ${config.id}: startup timed out.`} Poppet retries on a later request.`,
                  ),
                );

                if (
                  prior === undefined ||
                  Ref.getUnsafe(prior.state).status !== "needs-login" ||
                  Ref.getUnsafe(connection.state).status !== "needs-login"
                )
                  yield* logDiagnostic(config.id, diagnostic(connection));
              }),
            ),
            Effect.onInterrupt(() =>
              Effect.promise(() =>
                invalidateConnection(
                  connection,
                  `MCP ${config.id}: startup interrupted. Poppet retries on a later request.`,
                ),
              ),
            ),
          );

          return connection;
        }).pipe(locks.get(config.id)!.withPermit);

      const status = Effect.forEach(servers, (config) =>
        Effect.gen(function* () {
          const connection = connections.get(config.id);

          const signIn =
            isHTTPServer(config) && isOAuthServer(config)
              ? yield* signInStatus(config).pipe(
                  Effect.provideService(MCPSignIns, signIns),
                  Effect.orElseSucceed(() => null),
                )
              : null;

          if (
            connection !== undefined &&
            Ref.getUnsafe(connection.state).status === "connected" &&
            signIn?.signedIn === false
          )
            yield* Effect.promise(() =>
              requireLogin(connection, connection.signIn!.message).catch(() => {}),
            );

          const state = connection === undefined ? undefined : Ref.getUnsafe(connection.state);

          return {
            id: config.id,
            enabled: config.enabled,
            state: state?.status ?? (config.enabled ? ("idle" as const) : ("disabled" as const)),
            transport: isHTTPServer(config) ? ("http" as const) : ("stdio" as const),
            origin: isHTTPServer(config) ? new URL(config.url).origin : null,
            pid:
              connection?.transport instanceof ScopedStdioTransport
                ? connection.transport.pid
                : null,
            diagnostic: connection === undefined ? null : diagnostic(connection),
            retryAt: state?.status === "unavailable" ? retryAt(state) : null,
            tools: config.tools,
            scheduledTools: config.scheduledTools ?? [],
            scheduledReviewedTools: config.scheduledReviewedTools ?? [],
            availableTools:
              state?.status === "connected" ? state.tools.map((tool) => tool.toolName) : [],
            signIn,
          };
        }),
      );

      const tools = (id: string) =>
        Effect.gen(function* () {
          const config = servers.find((server) => server.id === id);

          if (config === undefined)
            return yield* Effect.fail(
              failed("Unknown MCP server. Use mcp servers to find its ID."),
            );
          const connection = yield* connect(config);
          const state = Ref.getUnsafe(connection.state);

          if (state.status !== "connected")
            return yield* Effect.fail(failed(diagnostic(connection) ?? `MCP ${id} is disabled.`));

          return state.discovered.map((name) => ({
            serverId: config.id,
            toolName: name,
            definition: state.tools.find((tool) => tool.toolName === name)?.definition ?? null,
            allowed: config.tools.includes(name),
            scheduled: config.scheduledTools?.includes(name) ?? false,
            scheduledReviewed: config.scheduledReviewedTools?.includes(name) ?? false,
            reviewed: config.reviewedTools?.includes(name) ?? false,
          }));
        });

      return {
        status,
        tools,
        snapshot: (scheduled) =>
          Effect.forEach(
            servers.filter(
              (config) =>
                config.enabled &&
                (!scheduled ||
                  (config.scheduledTools?.length ?? 0) > 0 ||
                  (config.scheduledReviewedTools?.length ?? 0) > 0),
            ),
            (config) =>
              connect(config).pipe(
                Effect.map((connection) => {
                  const state = Ref.getUnsafe(connection.state);

                  return state.status === "connected"
                    ? state.tools.filter(
                        (tool) =>
                          !scheduled ||
                          config.scheduledTools?.includes(tool.toolName) ||
                          config.scheduledReviewedTools?.includes(tool.toolName),
                      )
                    : [];
                }),
              ),
            { concurrency: "unbounded" },
          ).pipe(Effect.map((perServer) => perServer.flat())),
      };
    }),
  );

export const probeServer = (config: MCPServer) =>
  Effect.gen(function* () {
    const credentials = yield* ApiKeyStore;
    const signIns = yield* MCPSignIns;
    const clock = yield* Clock.Clock;
    const oauth = isHTTPServer(config) && isOAuthServer(config) ? config : null;
    let challenged = false;

    const observe: FetchLike = async (url, init) => {
      const response = await fetchHTTP(url, init);

      if (
        response.status === 401 &&
        /resource_metadata=/i.test(response.headers.get("www-authenticate") ?? "")
      )
        challenged = true;

      return response;
    };

    const resources = openConnectionResources(config, observe);
    yield* hydrateConnection(config, resources, credentials, signIns, () =>
      clock.currentTimeMillisUnsafe(),
    );

    return yield* Effect.tryPromise({
      try: async (signal) => {
        await resources.client.connect(resources.transport, { signal, timeout: 5000 });

        return (await listTools(resources.client, signal)).map((tool) => tool.name);
      },
      catch: (cause) =>
        challenged && oauth === null
          ? failed(`MCP ${config.id}: the server requires OAuth sign-in. Add it with --auth oauth.`)
          : startupFailure(config, cause),
    }).pipe(
      Effect.timeoutOrElse({
        duration: "8 seconds",
        orElse: () => Effect.fail(failed(`MCP ${config.id}: startup timed out.`)),
      }),
      Effect.ensuring(
        Effect.promise(async () => {
          await resources.client.close().catch(() => {});
          await resources.transport.close().catch(() => {});
        }),
      ),
    );
  });
