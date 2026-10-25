import { Client, type Tool as ServerTool } from "@modelcontextprotocol/client";
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
import { mcpServers, type MCPServer } from "#src/config";
import { MCPError } from "#src/errors";
import { ScopedStdioTransport } from "#src/transport";

/** An allowed discovered tool with validation and invocation owned by this package. */
export interface MCPTool {
  readonly definition: Tool;
  readonly serverId: string;
  readonly toolName: string;
  readonly prepare: (argumentsJSON: string) => Effect.Effect<
    {
      readonly execute: Effect.Effect<string, MCPError>;
    },
    MCPError
  >;
}

class MCPDiagnostic extends Data.TaggedError("MCPDiagnostic")<{ readonly message: string }> {}

interface Connection {
  readonly client: Client;
  readonly transport: ScopedStdioTransport;
  /** Reconnection attempts since this server last connected successfully. */
  retries: number;
  readonly now: () => number;
  state: "idle" | "connected" | "unavailable" | "disabled";
  diagnostic: string | null;
  failedAt: number | null;
  tools: ReadonlyArray<MCPTool>;
  closing: Promise<void> | null;
}

// A failed server reconnects on a later request after this delay, doubling per attempt.
const reconnectDelay = (retries: number) => Math.min(30_000 * 2 ** retries, 600_000);

const retryAt = (connection: Connection) =>
  connection.state === "unavailable" && connection.failedAt !== null
    ? connection.failedAt + reconnectDelay(connection.retries)
    : null;

export class MCP extends Context.Service<
  MCP,
  {
    readonly status: Effect.Effect<
      ReadonlyArray<{
        readonly id: string;
        readonly enabled: boolean;
        readonly state: Connection["state"];
        readonly pid: number | null;
        readonly diagnostic: string | null;
        /** When a failed server will reconnect on its next request, in epoch milliseconds. */
        readonly retryAt: number | null;
        readonly tools: ReadonlyArray<string>;
        readonly scheduledTools: ReadonlyArray<string>;
        readonly availableTools: ReadonlyArray<string>;
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
    `MCP ${config.id}: ${cause instanceof MCPDiagnostic ? cause.message : "Startup or protocol failed. Check the executable and server compatibility."}`,
  );

const close = (connection: Connection): Promise<void> => {
  connection.closing ??= (async () => {
    await connection.client.close().catch(() => {});
    await connection.transport.close();
  })();

  return connection.closing;
};

const invalidate = (connection: Connection, message: string) => {
  connection.state = "unavailable";
  connection.diagnostic ??= message;
  connection.failedAt ??= connection.now();

  return close(connection);
};

const resolveEnvironment = (config: MCPServer, credentials: ApiKeyStore["Service"]) =>
  Effect.gen(function* () {
    const env: Record<string, string> = {};

    for (const [name, reference] of Object.entries(config.environment ?? {})) {
      const value =
        "env" in reference
          ? process.env[reference.env]
          : yield* credentials.read(reference.credential).pipe(
              Effect.map((key) => (key === null ? undefined : Redacted.value(key))),
              Effect.mapError(() => failed(`MCP ${config.id}: cannot read selected credential.`)),
            );

      if (value === undefined || value.includes("\0") || value.length > 8192)
        return yield* Effect.fail(
          failed(
            `MCP ${config.id}: a selected environment or credential reference is missing or invalid.`,
          ),
        );
      env[name] = value;
    }

    return env;
  });

const discoverTools = async (config: MCPServer, client: Client, signal: AbortSignal) => {
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

  if (config.tools.some((name) => !names.has(name)))
    throw new MCPDiagnostic({
      message: "An allowlisted tool was not discovered. Check tools in config.json.",
    });

  return discovered.filter((tool) => config.tools.includes(tool.name));
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
  secrets: ReadonlyArray<string>,
  toolBytes: number,
): MCPTool => {
  if ((tool.description?.length ?? 0) > 4096 || tool.execution?.taskSupport === "required")
    throw new MCPDiagnostic({
      message: "Tool description exceeds 4096 characters or requires unsupported task execution.",
    });

  if (
    secrets.length > 0 &&
    containsSecret(Schema.decodeUnknownSync(Schema.JsonObject)(tool), secrets)
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
      if (connection.state !== "connected")
        return yield* Effect.fail(
          failed(connection.diagnostic ?? `MCP ${config.id} is unavailable.`),
        );

      const result = yield* Effect.tryPromise({
        try: (signal) =>
          connection.client.request(
            { method: "tools/call", params: { name: tool.name, arguments: args } },
            { signal, timeout: 10000 },
          ),
        catch: uncertain,
      });

      return yield* Effect.try({
        try: () => {
          if (!result.isError && output !== null && !output(result.structuredContent))
            throw new Error("Invalid structured output.");

          return toolResult(result, toolBytes, secrets);
        },
        catch: (cause) => (cause instanceof MCPError ? cause : uncertain()),
      });
    }).pipe(
      Effect.tapError((error) =>
        error.reason === "tool-uncertain"
          ? Effect.promise(() => invalidate(connection, error.message))
          : Effect.void,
      ),
      Effect.onInterrupt(() => Effect.promise(() => invalidate(connection, uncertain().message))),
    );

  return {
    serverId: config.id,
    toolName: tool.name,
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
      // Each server starts under its own lock, so one slow server never delays the others.
      const locks = new Map(servers.map((config) => [config.id, Semaphore.makeUnsafe(1)]));
      const clock = yield* Clock.Clock;
      const connections = new Map<string, Connection>();

      yield* Effect.addFinalizer(() =>
        Effect.promise(() => Promise.all([...connections.values()].map(close))),
      );

      const connect = (config: MCPServer) =>
        Effect.gen(function* () {
          const prior = connections.get(config.id);
          let retries = 0;

          if (prior !== undefined) {
            const due = retryAt(prior);

            if (due === null || clock.currentTimeMillisUnsafe() < due) return prior;
            // Replace the failed client only after its process has been reaped.
            yield* Effect.promise(() => close(prior).catch(() => {}));
            connections.delete(config.id);
            retries = prior.retries + 1;
          }

          const env: Record<string, string> = {};

          const client = new Client(
            { name: "poppet", version: "0.0.0" },
            { capabilities: {}, listMaxPages: 8 },
          );

          const transport = new ScopedStdioTransport({
            command: config.command,
            args: [...config.args],
            cwd: config.cwd ?? process.cwd(),
            env,
            stderr: "ignore",
            maxBufferSize: 262144,
          });

          const connection: Connection = {
            client,
            transport,
            retries,
            now: () => clock.currentTimeMillisUnsafe(),
            state: config.enabled ? "idle" : "disabled",
            diagnostic: null,
            failedAt: null,
            tools: [],
            closing: null,
          };

          const disconnected = () => {
            // The owner finalizer awaits this same teardown and reports any cleanup failure.
            void invalidate(
              connection,
              `MCP ${config.id}: disconnected or invalid protocol. Dispatched calls may have unknown effects; Poppet reconnects on a later request.`,
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
            Object.assign(env, yield* resolveEnvironment(config, credentials));
            const secrets = Object.values(env).filter((value) => value.length > 0);

            const discovered = yield* Effect.tryPromise({
              try: async (signal) => {
                await client.connect(transport, { signal, timeout: 5000 });

                return discoverTools(config, client, signal);
              },
              catch: (cause) => startupFailure(config, cause),
            });

            const tools = yield* Effect.try({
              try: () =>
                discovered.map((tool) => makeTool(config, tool, connection, secrets, toolBytes)),
              catch: (cause) => startupFailure(config, cause),
            });

            // A protocol callback can fail the connection before discovery's Promise resumes.
            if (connection.state === "unavailable")
              return yield* Effect.fail(
                failed(connection.diagnostic ?? `MCP ${config.id}: startup failed.`),
              );
            connection.tools = tools;
            connection.state = "connected";
            connection.retries = 0;
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
                yield* Console.error(connection.diagnostic);
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

      const status = Effect.sync(() =>
        servers.map((config) => {
          const connection = connections.get(config.id);

          return {
            id: config.id,
            enabled: config.enabled,
            state:
              connection?.state ?? (config.enabled ? ("idle" as const) : ("disabled" as const)),
            pid: connection?.transport.pid ?? null,
            diagnostic: connection?.diagnostic ?? null,
            retryAt: connection === undefined ? null : retryAt(connection),
            tools: config.tools,
            scheduledTools: config.scheduledTools ?? [],
            availableTools:
              connection?.state === "connected"
                ? connection.tools.map((tool) => tool.toolName)
                : [],
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

          if (connection.state !== "connected")
            return yield* Effect.fail(failed(connection.diagnostic ?? `MCP ${id} is disabled.`));

          return connection.tools.map((tool) => ({
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
                  connection.state === "connected"
                    ? connection.tools.filter(
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
