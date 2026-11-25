import { Client } from "@modelcontextprotocol/client";
import type {
  AuthProvider,
  FetchLike,
  StreamableHTTPClientTransportOptions,
  Tool as ServerTool,
} from "@modelcontextprotocol/client";
import { ApiKeyStore } from "@poppet/credentials";
import { Data, Effect, Redacted, Ref } from "effect";

import { isHTTPServer } from "#src/config";
import type { MCPReference, MCPServer } from "#src/config";
import { MCPError } from "#src/errors";
import { isOAuthServer, MCPLoginRequired, MCPSignIns, runtimeAuthorization } from "#src/oauth";
import type { RuntimeAuthorization } from "#src/oauth";
import {
  boundedFetch,
  checkReviewedToken,
  ScopedHTTPTransport,
  ScopedStdioTransport,
  singleReviewedPost,
} from "#src/transport";

export class MCPDiagnostic extends Data.TaggedError("MCPDiagnostic")<{
  readonly message: string;
}> {}

/** One tool Poppet cannot offer; the server's other tools remain available. */
export class UnsupportedTool extends Data.TaggedError("UnsupportedTool")<{
  readonly message: string;
}> {}

export type ConnectionState<ToolEntry = unknown> =
  | { readonly status: "idle"; readonly retries: number }
  | { readonly status: "disabled" }
  | {
      readonly status: "connected";
      readonly tools: ReadonlyArray<ToolEntry>;
      readonly discovered: ReadonlyArray<string>;
      /** Allowed tools skipped because Poppet cannot support their definitions. */
      readonly diagnostic: string | null;
    }
  | {
      readonly status: "unavailable";
      readonly diagnostic: string;
      readonly failedAt: number;
      readonly retries: number;
    }
  | { readonly status: "needs-login"; readonly diagnostic: string };

export interface Connection<ToolEntry = unknown> {
  readonly client: Client;
  readonly transport: ScopedStdioTransport | ScopedHTTPTransport;
  readonly now: () => number;
  readonly logCloseFailure: () => Promise<void>;
  readonly token: () => string | undefined;
  readonly state: Ref.Ref<ConnectionState<ToolEntry>>;
  closing: Promise<void> | null;
  readonly signIn: { readonly required: () => boolean; readonly message: string } | null;
}

export interface AuthorizationSlot {
  current: RuntimeAuthorization | null;
}

export interface ConnectionResources {
  readonly references: Record<string, string>;
  readonly authorization: AuthorizationSlot;
  readonly client: Client;
  readonly transport: ScopedStdioTransport | ScopedHTTPTransport;
}

export const failed = (message: string) => new MCPError({ reason: "tool-network", message });

export const startupFailure = (config: MCPServer, cause: unknown) =>
  failed(
    `MCP ${config.id}: ${cause instanceof MCPDiagnostic ? cause.message : isHTTPServer(config) ? "Startup or protocol failed. Check the URL, headers and server compatibility." : "Startup or protocol failed. Check the executable and server compatibility."}`,
  );

export const authorizationFailure = (
  config: MCPServer,
  cause: Effect.Error<ReturnType<typeof runtimeAuthorization>>,
) =>
  failed(
    cause instanceof MCPLoginRequired
      ? cause.message
      : `MCP ${config.id}: cannot read its saved sign-in or client secret.`,
  );

export const reconnectDelay = (retries: number) => Math.min(30_000 * 2 ** retries, 600_000);

export const retryAt = (state: Extract<ConnectionState, { status: "unavailable" }>) =>
  state.failedAt + reconnectDelay(state.retries);

export const diagnostic = <ToolEntry>(connection: Connection<ToolEntry>) => {
  const state = Ref.getUnsafe(connection.state);

  return state.status === "unavailable" ||
    state.status === "needs-login" ||
    state.status === "connected"
    ? state.diagnostic
    : null;
};

export const logDiagnostic = (server: string, detail: string | null) =>
  Effect.logWarning("mcp server diagnostic").pipe(Effect.annotateLogs({ server, detail }));

export const closeConnection = <ToolEntry>(connection: Connection<ToolEntry>): Promise<void> => {
  connection.closing ??= (async () => {
    await connection.client.close().catch(() => {});
    await connection.transport.close().catch(connection.logCloseFailure);
  })();

  return connection.closing;
};

export const requireLogin = <ToolEntry>(connection: Connection<ToolEntry>, message: string) => {
  Effect.runSync(Ref.set(connection.state, { status: "needs-login", diagnostic: message }));

  return closeConnection(connection);
};

export const invalidateConnection = <ToolEntry>(
  connection: Connection<ToolEntry>,
  message: string,
) => {
  const state = Ref.getUnsafe(connection.state);

  if (state.status !== "unavailable" && state.status !== "needs-login") {
    if (connection.signIn?.required() === true) {
      return requireLogin(connection, connection.signIn.message);
    }

    Effect.runSync(
      Ref.set(connection.state, {
        status: "unavailable",
        diagnostic: message,
        failedAt: connection.now(),
        retries: state.status === "idle" ? state.retries : 0,
      }),
    );
  }

  return closeConnection(connection);
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

    if (value === undefined || value.length > 8192 || invalid(value)) {
      return yield* Effect.fail(
        failed(
          `MCP ${config.id}: a selected environment, credential or header reference is missing or invalid.`,
        ),
      );
    }

    return value;
  });

const resolveReferences = (config: MCPServer, credentials: ApiKeyStore["Service"]) =>
  Effect.gen(function* () {
    const values: Record<string, string> = {};
    const secrets: Array<string> = [];

    if (isHTTPServer(config)) {
      for (const [name, reference] of Object.entries(config.headers ?? {})) {
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

        if ("credential" in reference) {
          secrets.push(value);
        }
      }
    }

    return { values, secrets: secrets.filter((value) => value.length > 0) };
  });

interface RejectedRequest {
  readonly token: string;
  readonly signal: AbortSignal | undefined;
}

const delegate = (
  authorization: AuthorizationSlot,
  rejected: WeakMap<Response, RejectedRequest>,
): AuthProvider => ({
  token: async () => checkReviewedToken(await authorization.current?.readToken()),
  onUnauthorized: async ({ response }) => {
    const request = rejected.get(response);

    if (authorization.current === null || request === undefined) {
      throw new Error("Sign-in required.");
    }

    await authorization.current.refresh(request.token, response, request.signal);
  },
});

const makeClient = () =>
  new Client({ name: "poppet", version: "0.0.0" }, { capabilities: {}, listMaxPages: 8 });

const maxMessageBytes = 4 * 1024 * 1024;

export const fetchHTTP = boundedFetch(
  maxMessageBytes,
  (url, init) => fetch(url, init),
  16 * 1024 * 1024,
);

const makeTransport = (
  config: MCPServer,
  references: Record<string, string>,
  fetchFn: FetchLike = fetchHTTP,
  authorization: AuthorizationSlot = { current: null },
) => {
  if (!isHTTPServer(config)) {
    return new ScopedStdioTransport({
      command: config.command,
      args: [...config.args],
      cwd: config.cwd ?? process.cwd(),
      env: references,
      stderr: "ignore",
      maxBufferSize: maxMessageBytes,
    });
  }

  const rejected = new WeakMap<Response, RejectedRequest>();

  const transportFetch: FetchLike = async (url, init) => {
    const response = await fetchFn(url, init);

    if (response.status === 401) {
      const bearer = new Headers(init?.headers).get("authorization");

      if (bearer?.startsWith("Bearer ")) {
        rejected.set(response, { token: bearer.slice(7), signal: init?.signal ?? undefined });
      }
    }

    return response;
  };

  const options: StreamableHTTPClientTransportOptions = {
    requestInit: { headers: references },
    fetch: singleReviewedPost(transportFetch),
    redirectPolicy: "same-origin",
    reconnectionOptions: {
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 30_000,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 0,
    },
  };

  if (isOAuthServer(config)) {
    options.authProvider = delegate(authorization, rejected);
  }

  return new ScopedHTTPTransport(new URL(config.url), options);
};

export const openConnectionResources = (
  config: MCPServer,
  fetch?: FetchLike,
): ConnectionResources => {
  const references: Record<string, string> = {};
  const authorization: AuthorizationSlot = { current: null };
  const client = makeClient();
  const transport = makeTransport(config, references, fetch, authorization);

  return { references, authorization, client, transport };
};

export const hydrateConnection = (
  config: MCPServer,
  resources: ConnectionResources,
  credentials: ApiKeyStore["Service"],
  signIns: MCPSignIns["Service"],
  now: () => number,
  onLoginRequired?: () => void,
) =>
  Effect.gen(function* () {
    const { values, secrets } = yield* resolveReferences(config, credentials);
    Object.assign(resources.references, values);

    const oauth = isHTTPServer(config) && isOAuthServer(config) ? config : null;

    if (oauth !== null) {
      resources.authorization.current = yield* runtimeAuthorization(oauth, now).pipe(
        Effect.provideService(MCPSignIns, signIns),
        Effect.provideService(ApiKeyStore, credentials),
        Effect.catchTag("MCPLoginRequired", (error) => {
          onLoginRequired?.();

          return Effect.fail(error);
        }),
        Effect.mapError((error) => authorizationFailure(config, error)),
      );
    }

    return () =>
      resources.authorization.current === null
        ? secrets
        : [...secrets, ...resources.authorization.current.secrets()];
  });

export const listTools = async (client: Client, signal: AbortSignal) => {
  if (!client.getServerCapabilities()?.tools) {
    throw new MCPDiagnostic({ message: "Server does not advertise tools capability." });
  }

  const discovered: Array<ServerTool> = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;

  for (let page = 0; ; page++) {
    if (page === 8) {
      throw new MCPDiagnostic({ message: "Discovery exceeds 8 pages." });
    }

    const result = await client.request(
      { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
      { signal, timeout: 5000 },
    );

    bytes += Buffer.byteLength(JSON.stringify(result));

    if (bytes > 262_144 || discovered.length + result.tools.length > 128) {
      throw new MCPDiagnostic({ message: "Discovery exceeds 128 tools or 256 KiB." });
    }

    for (const tool of result.tools) {
      if (names.has(tool.name) || tool.name.length > 256) {
        throw new MCPDiagnostic({ message: "Duplicate or oversized tool name." });
      }

      names.add(tool.name);
      discovered.push(tool);
    }

    cursor = result.nextCursor;

    if (cursor === undefined) {
      break;
    }

    if (cursor.length > 1024 || cursors.has(cursor)) {
      throw new MCPDiagnostic({ message: "Invalid discovery cursor." });
    }

    cursors.add(cursor);
  }

  return discovered;
};

export const discoverTools = async (config: MCPServer, client: Client, signal: AbortSignal) => {
  const discovered = await listTools(client, signal);

  if (config.tools.some((name) => !discovered.some((tool) => tool.name === name))) {
    throw new MCPDiagnostic({
      message: "An allowlisted tool was not discovered. Check tools in config.json.",
    });
  }

  return discovered;
};
