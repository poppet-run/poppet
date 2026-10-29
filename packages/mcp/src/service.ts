import {
  Client,
  InsufficientScopeError,
  type AuthProvider,
  type FetchLike,
  type StreamableHTTPClientTransportOptions,
  type Tool as ServerTool,
} from "@modelcontextprotocol/client";
import { ApiKeyStore } from "@poppet/credentials";
import type { Tool } from "@poppet/provider";
import { Clock, Console, Context, Data, Effect, Layer, Redacted, Schema, Semaphore } from "effect";

import {
  compileSchema,
  containsSecret,
  decodeArguments,
  definition,
  toolResult,
} from "#src/catalog";
import { isHTTPServer, mcpServers, type MCPReference, type MCPServer } from "#src/config";
import { MCPError } from "#src/errors";
import {
  isOAuthServer,
  MCPSignIns,
  runtimeAuthorization,
  signInStatus,
  type RuntimeAuthorization,
} from "#src/oauth";
import { boundedFetch, ScopedHTTPTransport, ScopedStdioTransport } from "#src/transport";

/** An allowed discovered tool with validation and invocation owned by this package. */
export interface MCPTool {
  readonly definition: Tool;
  readonly serverId: string;
  readonly toolName: string;
  readonly availableAfterUntrusted: boolean;
  readonly prepare: (argumentsJSON: string) => Effect.Effect<
    {
      readonly execute: Effect.Effect<string, MCPError>;
    },
    MCPError
  >;
}

class MCPDiagnostic extends Data.TaggedError("MCPDiagnostic")<{ readonly message: string }> {}

type ConnectionState =
  | { readonly status: "idle"; readonly retries: number }
  | { readonly status: "disabled" }
  | { readonly status: "connected"; readonly tools: ReadonlyArray<MCPTool> }
  | {
      readonly status: "unavailable";
      readonly diagnostic: string;
      readonly failedAt: number;
      /** Failed reconnects since the last successful connection. */
      readonly retries: number;
    }
  /** An OAuth server waits for `mcp login` rather than retrying on a backoff. */
  | { readonly status: "needs-login"; readonly diagnostic: string };

interface Connection {
  readonly client: Client;
  readonly transport: ScopedStdioTransport | ScopedHTTPTransport;
  readonly now: () => number;
  state: ConnectionState;
  closing: Promise<void> | null;
  /** OAuth servers report when their saved sign-in is missing or was rejected. */
  readonly signIn: { readonly required: () => boolean; readonly message: string } | null;
}

// A failed server reconnects on a later request after this delay, doubling per attempt.
const reconnectDelay = (retries: number) => Math.min(30_000 * 2 ** retries, 600_000);

const retryAt = (state: Extract<ConnectionState, { status: "unavailable" }>) =>
  state.failedAt + reconnectDelay(state.retries);

const diagnostic = (connection: Connection) =>
  connection.state.status === "unavailable" || connection.state.status === "needs-login"
    ? connection.state.diagnostic
    : null;

export class MCP extends Context.Service<
  MCP,
  {
    readonly status: Effect.Effect<
      ReadonlyArray<{
        readonly id: string;
        readonly enabled: boolean;
        readonly state: ConnectionState["status"];
        readonly transport: "stdio" | "http";
        /** The HTTP endpoint's origin; paths and queries are omitted. */
        readonly origin: string | null;
        readonly pid: number | null;
        readonly diagnostic: string | null;
        /** When a failed server will reconnect on its next request, in epoch milliseconds. */
        readonly retryAt: number | null;
        readonly tools: ReadonlyArray<string>;
        readonly scheduledTools: ReadonlyArray<string>;
        readonly availableTools: ReadonlyArray<string>;
        /** Saved OAuth sign-in for OAuth servers, without token values. */
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
        readonly definition: MCPTool["definition"];
        readonly scheduled: boolean;
      }>,
      MCPError
    >;
  }
>()("poppet/MCP") {}

const failed = (message: string) => new MCPError({ reason: "tool-network", message });

const startupFailure = (config: MCPServer, cause: unknown) =>
  failed(
    `MCP ${config.id}: ${cause instanceof MCPDiagnostic ? cause.message : isHTTPServer(config) ? "Startup or protocol failed. Check the URL, headers and server compatibility." : "Startup or protocol failed. Check the executable and server compatibility."}`,
  );

const close = (connection: Connection): Promise<void> => {
  connection.closing ??= (async () => {
    await connection.client.close().catch(() => {});
    await connection.transport.close();
  })();

  return connection.closing;
};

const invalidate = (connection: Connection, message: string) => {
  const state = connection.state;

  // Repeated callbacks keep the first failure and its original backoff deadline.
  if (state.status !== "unavailable" && state.status !== "needs-login")
    connection.state =
      connection.signIn?.required() === true
        ? { status: "needs-login", diagnostic: connection.signIn.message }
        : {
            status: "unavailable",
            diagnostic: message,
            failedAt: connection.now(),
            retries: state.status === "idle" ? state.retries : 0,
          };

  return close(connection);
};

const resolveReference = (
  config: MCPServer,
  reference: MCPReference,
  credentials: ApiKeyStore["Service"],
  invalid: (value: string) => boolean,
) =>
  Effect.gen(function* () {
    const value =
      "env" in reference
        ? process.env[reference.env]
        : yield* credentials.read(reference.credential).pipe(
            Effect.map((key) => (key === null ? undefined : Redacted.value(key))),
            Effect.mapError(() => failed(`MCP ${config.id}: cannot read selected credential.`)),
          );

    if (value === undefined || value.length > 8192 || invalid(value))
      return yield* Effect.fail(
        failed(
          `MCP ${config.id}: a selected environment, credential or header reference is missing or invalid.`,
        ),
      );

    return value;
  });

/** Child environment values for stdio servers, or request headers for HTTP servers, with their secrets. */
const resolveReferences = (config: MCPServer, credentials: ApiKeyStore["Service"]) =>
  Effect.gen(function* () {
    const values: Record<string, string> = {};
    const secrets: string[] = [];

    if (isHTTPServer(config)) {
      for (const [name, reference] of Object.entries(config.headers ?? {})) {
        // Header values are visible ASCII and spaces; an empty secret would make the prefix the value.
        const value = yield* resolveReference(
          config,
          reference,
          credentials,
          (text) => text.length === 0 || !/^[\u0020-\u007E]*$/.test(text),
        );

        values[name] = `${reference.prefix ?? ""}${value}`;
        secrets.push(value);
      }
    } else {
      for (const [name, reference] of Object.entries(config.environment ?? {})) {
        const value = yield* resolveReference(config, reference, credentials, (text) =>
          text.includes("\0"),
        );

        values[name] = value;
        secrets.push(value);
      }
    }

    return { values, secrets: secrets.filter((value) => value.length > 0) };
  });

const listTools = async (client: Client, signal: AbortSignal) => {
  if (!client.getServerCapabilities()?.tools)
    throw new MCPDiagnostic({ message: "Server does not advertise tools capability." });
  const discovered: ServerTool[] = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;

  for (let page = 0; ; page++) {
    if (page === 8) throw new MCPDiagnostic({ message: "Discovery exceeds 8 pages." });

    // Each cursor depends on the previous page.
    // eslint-disable-next-line no-await-in-loop
    const result = await client.request(
      { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
      { signal, timeout: 5000 },
    );

    bytes += Buffer.byteLength(JSON.stringify(result));

    if (bytes > 262144 || discovered.length + result.tools.length > 128)
      throw new MCPDiagnostic({ message: "Discovery exceeds 128 tools or 256 KiB." });

    for (const tool of result.tools) {
      if (names.has(tool.name) || tool.name.length > 256)
        throw new MCPDiagnostic({ message: "Duplicate or oversized tool name." });
      names.add(tool.name);
      discovered.push(tool);
    }

    cursor = result.nextCursor;

    if (cursor === undefined) break;

    if (cursor.length > 1024 || cursors.has(cursor))
      throw new MCPDiagnostic({ message: "Invalid discovery cursor." });
    cursors.add(cursor);
  }

  return discovered;
};

const discoverTools = async (config: MCPServer, client: Client, signal: AbortSignal) => {
  const discovered = await listTools(client, signal);

  if (config.tools.some((name) => !discovered.some((tool) => tool.name === name)))
    throw new MCPDiagnostic({
      message: "An allowlisted tool was not discovered. Check tools in config.json.",
    });

  return discovered.filter((tool) => config.tools.includes(tool.name));
};

/** Filled during startup, after the saved sign-in has been read. */
interface AuthorizationSlot {
  current: RuntimeAuthorization | null;
}

const delegate = (authorization: AuthorizationSlot): AuthProvider => ({
  token: () => Promise.resolve(authorization.current?.token()),
  onUnauthorized: (context) =>
    authorization.current === null
      ? Promise.reject(new Error("Sign-in required."))
      : authorization.current.authProvider.onUnauthorized!(context),
});

const makeClient = () =>
  new Client({ name: "poppet", version: "0.0.0" }, { capabilities: {}, listMaxPages: 8 });

/** Transports read references at start or per request, after startup resolves them. */
const makeTransport = (
  config: MCPServer,
  references: Record<string, string>,
  fetch: FetchLike = boundedFetch(262144),
  authorization: AuthorizationSlot = { current: null },
) => {
  if (!isHTTPServer(config))
    return new ScopedStdioTransport({
      command: config.command,
      args: [...config.args],
      cwd: config.cwd ?? process.cwd(),
      env: references,
      stderr: "ignore",
      maxBufferSize: 262144,
    });

  const options: StreamableHTTPClientTransportOptions = {
    requestInit: { headers: references },
    fetch,
    redirectPolicy: "same-origin",
    // Poppet's own backoff owns reconnection; a dropped stream fails the connection.
    reconnectionOptions: {
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 30000,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 0,
    },
  };

  // Startup supplies OAuth tokens after reading the saved sign-in, like other references.
  if (isOAuthServer(config)) options.authProvider = delegate(authorization);

  return new ScopedHTTPTransport(new URL(config.url), options);
};

const compile = (input: Schema.JsonObject) => {
  try {
    return compileSchema(input);
  } catch {
    throw new MCPDiagnostic({
      message:
        "Unsupported tool schema. Use draft-07 or 2020-12 JSON Schema, at most 16 KiB, depth 16 and 512 nodes; references, patterns and unknown formats or keywords are unsupported.",
    });
  }
};

const makeTool = (
  config: MCPServer,
  tool: ServerTool,
  connection: Connection,
  /** Read per use, because OAuth refresh replaces the access token. */
  secrets: () => ReadonlyArray<string>,
  toolBytes: number,
): MCPTool => {
  if ((tool.description?.length ?? 0) > 4096 || tool.execution?.taskSupport === "required")
    throw new MCPDiagnostic({
      message: "Tool description exceeds 4096 characters or requires unsupported task execution.",
    });

  if (
    secrets().length > 0 &&
    containsSecret(Schema.decodeUnknownSync(Schema.JsonObject)(tool), secrets())
  )
    throw new MCPDiagnostic({ message: "Tool definition contains a selected credential." });
  const schema = Schema.decodeUnknownSync(Schema.JsonObject)(tool.inputSchema);

  if (schema.type !== "object")
    throw new MCPDiagnostic({ message: "Tool input must be an object schema." });
  const validate = compile(schema);

  const output =
    tool.outputSchema === undefined
      ? null
      : compile(Schema.decodeUnknownSync(Schema.JsonObject)(tool.outputSchema));

  const uncertain = () =>
    new MCPError({
      reason: "tool-uncertain",
      message: `MCP ${config.id}/${tool.name}: Connection or protocol failed after dispatch; effects may be unknown. No call was retried; Poppet reconnects on a later request.`,
    });

  const execute = (args: Schema.JsonObject) =>
    Effect.gen(function* () {
      if (connection.state.status !== "connected")
        return yield* Effect.fail(
          failed(diagnostic(connection) ?? `MCP ${config.id} is unavailable.`),
        );

      const result = yield* Effect.tryPromise({
        try: (signal) =>
          connection.client.request(
            { method: "tools/call", params: { name: tool.name, arguments: args } },
            { signal, timeout: 10000 },
          ),
        // A rejected sign-in or missing scope is a refusal before the call ran.
        catch: (cause) => {
          if (connection.signIn?.required() === true) return failed(connection.signIn.message);

          if (cause instanceof InsufficientScopeError)
            return new MCPError({
              reason: "tool-permission",
              message: `MCP ${config.id}/${tool.name}: the server requires the scope ${cause.requiredScope ?? "it names"}. Add it to oauth.scopes and run poppet mcp login ${config.id}.`,
            });

          return uncertain();
        },
      });

      return yield* Effect.try({
        try: () => {
          if (!result.isError && output !== null && !output(result.structuredContent))
            throw new Error("Invalid structured output.");

          return toolResult(result, toolBytes, secrets());
        },
        catch: (cause) => (cause instanceof MCPError ? cause : uncertain()),
      });
    }).pipe(
      Effect.tapError((error) =>
        error.reason === "tool-uncertain" || connection.signIn?.required() === true
          ? Effect.promise(() => invalidate(connection, error.message))
          : Effect.void,
      ),
      Effect.onInterrupt(() => Effect.promise(() => invalidate(connection, uncertain().message))),
    );

  return {
    serverId: config.id,
    toolName: tool.name,
    availableAfterUntrusted: config.availableAfterUntrusted === true,
    definition: definition(config.id, tool.name, tool.description ?? "", schema),
    prepare: (argumentsJSON) =>
      Effect.try({
        try: () => {
          const args = decodeArguments(argumentsJSON);

          if (!validate(args)) throw new Error("Arguments do not match schema.");

          return { execute: execute(args) };
        },
        catch: () =>
          new MCPError({
            reason: "tool-arguments",
            message: `MCP ${config.id}/${tool.name}: input must contain a JSON object matching the original input schema.`,
          }),
      }),
  };
};

/** Lazily starts owner-configured processes; the layer's scope owns every client. */
export const makeMCPLive = (toolBytes: number) =>
  Layer.effect(
    MCP,
    Effect.gen(function* () {
      const servers = yield* mcpServers;
      const credentials = yield* ApiKeyStore;
      const signIns = yield* MCPSignIns;
      // Each server starts under its own lock, so one slow server never delays the others.
      const locks = new Map(servers.map((config) => [config.id, Semaphore.makeUnsafe(1)]));
      const clock = yield* Clock.Clock;
      const now = () => clock.currentTimeMillisUnsafe();
      const connections = new Map<string, Connection>();

      yield* Effect.addFinalizer(() =>
        Effect.promise(() => Promise.all([...connections.values()].map(close))),
      );

      const connect = (config: MCPServer) =>
        Effect.gen(function* () {
          const prior = connections.get(config.id);
          let retries = 0;

          if (prior !== undefined) {
            const state = prior.state;

            // A server waiting for sign-in rechecks its saved sign-in, which `mcp login` may
            // have replaced from another process, on every request without contacting it.
            if (
              state.status !== "needs-login" &&
              (state.status !== "unavailable" || clock.currentTimeMillisUnsafe() < retryAt(state))
            )
              return prior;
            // Replace the failed client only after its process has been reaped.
            yield* Effect.promise(() => close(prior).catch(() => {}));
            connections.delete(config.id);
            retries = state.status === "unavailable" ? state.retries + 1 : 0;
          }

          const references: Record<string, string> = {};
          const authorization: AuthorizationSlot = { current: null };
          const missing = { value: false };
          const oauth = isHTTPServer(config) && isOAuthServer(config) ? config : null;

          const client = makeClient();

          const transport = makeTransport(config, references, undefined, authorization);

          const connection: Connection = {
            client,
            transport,
            now,
            state: config.enabled ? { status: "idle", retries } : { status: "disabled" },
            closing: null,
            signIn:
              oauth === null
                ? null
                : {
                    required: () =>
                      missing.value || authorization.current?.loginRequired() === true,
                    message: `MCP ${config.id}: sign-in required. Run poppet mcp login ${config.id}.`,
                  },
          };

          const disconnected = () => {
            // The owner finalizer awaits this same teardown and reports any cleanup failure.
            void invalidate(
              connection,
              // Startup failures keep their configuration hint; no call has been dispatched yet.
              connection.state.status === "idle"
                ? `${startupFailure(config, null).message} Poppet retries on a later request.`
                : `MCP ${config.id}: disconnected or invalid protocol. Dispatched calls may have unknown effects; Poppet reconnects on a later request.`,
            ).catch(() => {});
          };

          // The SDK exposes callback properties rather than EventTarget listeners.
          // eslint-disable-next-line unicorn/prefer-add-event-listener
          client.onclose = disconnected;
          // eslint-disable-next-line unicorn/prefer-add-event-listener
          client.onerror = disconnected;
          connections.set(config.id, connection);

          if (!config.enabled) return connection;

          const startup = Effect.gen(function* () {
            const { values, secrets } = yield* resolveReferences(config, credentials);
            Object.assign(references, values);

            if (oauth !== null)
              authorization.current = yield* runtimeAuthorization(oauth, now).pipe(
                Effect.provideService(MCPSignIns, signIns),
                Effect.provideService(ApiKeyStore, credentials),
                Effect.catchTag("MCPLoginRequired", (error) => {
                  missing.value = true;

                  return Effect.fail(failed(error.message));
                }),
                Effect.mapError((error) =>
                  error instanceof MCPError
                    ? error
                    : failed(`MCP ${config.id}: cannot read its saved sign-in or client secret.`),
                ),
              );

            const current = () =>
              authorization.current === null
                ? secrets
                : [...secrets, authorization.current.token()];

            const discovered = yield* Effect.tryPromise({
              try: async (signal) => {
                await client.connect(transport, { signal, timeout: 5000 });

                return discoverTools(config, client, signal);
              },
              catch: (cause) => startupFailure(config, cause),
            });

            const tools = yield* Effect.try({
              try: () =>
                discovered.map((tool) => makeTool(config, tool, connection, current, toolBytes)),
              catch: (cause) => startupFailure(config, cause),
            });

            // A protocol callback can fail the connection before discovery's Promise resumes.
            if (connection.state.status === "unavailable")
              return yield* Effect.fail(failed(connection.state.diagnostic));
            connection.state = { status: "connected", tools };
          }).pipe(Effect.timeout("8 seconds"));

          yield* startup.pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* Effect.promise(() =>
                  invalidate(
                    connection,
                    `${error instanceof MCPError ? error.message : `MCP ${config.id}: startup timed out.`} Poppet retries on a later request.`,
                  ),
                );

                // A server still waiting for sign-in reported it on its first failure.
                if (
                  prior?.state.status !== "needs-login" ||
                  connection.state.status !== "needs-login"
                )
                  yield* Console.error(diagnostic(connection));
              }),
            ),
            Effect.onInterrupt(() =>
              Effect.promise(() =>
                invalidate(
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
          const state = connection?.state;

          const signIn =
            isHTTPServer(config) && isOAuthServer(config)
              ? yield* signInStatus(config).pipe(
                  Effect.provideService(MCPSignIns, signIns),
                  Effect.orElseSucceed(() => null),
                )
              : null;

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

          if (connection.state.status !== "connected")
            return yield* Effect.fail(failed(diagnostic(connection) ?? `MCP ${id} is disabled.`));

          return connection.state.tools.map((tool) => ({
            serverId: tool.serverId,
            toolName: tool.toolName,
            definition: tool.definition,
            scheduled: config.scheduledTools?.includes(tool.toolName) ?? false,
          }));
        });

      return {
        status,
        tools,
        snapshot: (scheduled) =>
          Effect.forEach(
            servers.filter(
              (config) =>
                config.enabled && (!scheduled || (config.scheduledTools?.length ?? 0) > 0),
            ),
            (config) =>
              connect(config).pipe(
                Effect.map((connection) =>
                  connection.state.status === "connected"
                    ? connection.state.tools.filter(
                        (tool) => !scheduled || config.scheduledTools?.includes(tool.toolName),
                      )
                    : [],
                ),
              ),
            { concurrency: "unbounded" },
          ).pipe(Effect.map((perServer) => perServer.flat())),
      };
    }),
  );

/**
 * Connects once with an entry and lists every discovered tool name, ignoring its allowlist, so
 * the owner can review names before allowing them. The connection closes before returning.
 */
export const probeServer = (config: MCPServer) =>
  Effect.gen(function* () {
    const credentials = yield* ApiKeyStore;
    const clock = yield* Clock.Clock;
    const { values } = yield* resolveReferences(config, credentials);
    const oauth = isHTTPServer(config) && isOAuthServer(config) ? config : null;
    const authorization: AuthorizationSlot = { current: null };
    let challenged = false;

    if (oauth !== null)
      authorization.current = yield* runtimeAuthorization(oauth, () =>
        clock.currentTimeMillisUnsafe(),
      ).pipe(
        Effect.catchTag("MCPLoginRequired", (error) => Effect.fail(failed(error.message))),
        Effect.mapError((error) =>
          error instanceof MCPError
            ? error
            : failed(`MCP ${config.id}: cannot read its saved sign-in or client secret.`),
        ),
      );
    const base = boundedFetch(262144);

    // A 401 naming protected resource metadata means the server expects OAuth.
    const observe: FetchLike = async (url, init) => {
      const response = await base(url, init);

      if (
        response.status === 401 &&
        /resource_metadata=/i.test(response.headers.get("www-authenticate") ?? "")
      )
        challenged = true;

      return response;
    };

    const client = makeClient();
    const transport = makeTransport(config, values, observe, authorization);

    return yield* Effect.tryPromise({
      try: async (signal) => {
        await client.connect(transport, { signal, timeout: 5000 });

        return (await listTools(client, signal)).map((tool) => tool.name);
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
          await client.close().catch(() => {});
          await transport.close().catch(() => {});
        }),
      ),
    );
  });
