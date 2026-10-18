import { Client, type Tool as ServerTool } from "@modelcontextprotocol/client";
import { ApiKeyStore } from "@poppet/credentials";
import type { Tool } from "@poppet/provider";
import { Console, Context, Data, Effect, Layer, Redacted, Schema, Semaphore } from "effect";

import { compileSchema, decodeArguments, definition, toolResult } from "#src/catalog";
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
  state: "idle" | "connected" | "unavailable" | "disabled";
  diagnostic: string | null;
  tools: ReadonlyArray<MCPTool>;
}

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

/** Lazily starts owner-configured processes; the layer's scope owns every client. */
export const makeMCPLive = (toolBytes: number) =>
  Layer.effect(
    MCP,
    Effect.gen(function* () {
      const servers = yield* mcpServers;
      const credentials = yield* ApiKeyStore;
      const lock = yield* Semaphore.make(1);
      const connections = new Map<string, Connection>();

      const close = async (connection: Connection) => {
        await connection.client.close().catch(() => {});
        await connection.transport.close();
      };

      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await Promise.all([...connections.values()].map(close));
        }),
      );

      const connect = (config: MCPServer) =>
        Effect.gen(function* () {
          const prior = connections.get(config.id);

          if (prior !== undefined) return prior;
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
            state: config.enabled ? "idle" : "disabled",
            diagnostic: null,
            tools: [],
          };

          const disconnected = () => {
            connection.state = "unavailable";
            connection.diagnostic ??= `MCP ${config.id}: disconnected or invalid protocol. Restart to reconnect; dispatched calls may have unknown effects.`;
          };

          // The SDK exposes callback properties rather than EventTarget listeners.
          // eslint-disable-next-line unicorn/prefer-add-event-listener
          client.onclose = disconnected;
          // eslint-disable-next-line unicorn/prefer-add-event-listener
          client.onerror = disconnected;
          connections.set(config.id, connection);

          if (!config.enabled) return connection;

          const startup = Effect.gen(function* () {
            for (const [name, reference] of Object.entries(config.environment ?? {})) {
              const value =
                "env" in reference
                  ? process.env[reference.env]
                  : yield* credentials.read(reference.credential).pipe(
                      Effect.map((key) => (key === null ? undefined : Redacted.value(key))),
                      Effect.mapError(() =>
                        failed(`MCP ${config.id}: cannot read selected credential.`),
                      ),
                    );

              if (value === undefined || value.includes("\0") || value.length > 8192)
                return yield* Effect.fail(
                  failed(
                    `MCP ${config.id}: a selected environment or credential reference is missing or invalid.`,
                  ),
                );
              env[name] = value;
            }

            return yield* Effect.tryPromise({
              try: async (signal) => {
                await client.connect(transport, { signal, timeout: 5000 });

                if (!client.getServerCapabilities()?.tools)
                  throw new MCPDiagnostic({
                    message: "Server does not advertise tools capability.",
                  });
                const discovered: ServerTool[] = [];
                const names = new Set<string>();
                const cursors = new Set<string>();
                let cursor: string | undefined;
                let bytes = 0;

                for (let page = 0; ; page++) {
                  if (page === 8)
                    throw new MCPDiagnostic({ message: "Discovery exceeds 8 pages." });

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

                const tools: MCPTool[] = [];

                for (const tool of discovered) {
                  if (!config.tools.includes(tool.name)) continue;

                  if (
                    (tool.description?.length ?? 0) > 4096 ||
                    tool.execution?.taskSupport === "required"
                  )
                    throw new MCPDiagnostic({
                      message:
                        "Tool description exceeds 4096 characters or requires unsupported task execution.",
                    });

                  if (
                    Object.values(env).some((value) =>
                      JSON.stringify(tool).includes(JSON.stringify(value).slice(1, -1)),
                    )
                  )
                    throw new MCPDiagnostic({
                      message: "Tool definition contains a selected credential.",
                    });
                  const schema = Schema.decodeUnknownSync(Schema.JsonObject)(tool.inputSchema);

                  if (schema.type !== "object")
                    throw new MCPDiagnostic({ message: "Tool input must be an object schema." });

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

                  const validate = compile(schema);

                  const output =
                    tool.outputSchema === undefined
                      ? null
                      : compile(Schema.decodeUnknownSync(Schema.JsonObject)(tool.outputSchema));

                  tools.push({
                    serverId: config.id,
                    toolName: tool.name,
                    definition: definition(config.id, tool.name, tool.description ?? "", schema),
                    prepare: (argumentsJSON) =>
                      Effect.try({
                        try: () => {
                          const args = decodeArguments(argumentsJSON);

                          if (!validate(args)) throw new Error("Arguments do not match schema.");

                          return {
                            execute: Effect.tryPromise({
                              try: async (callSignal) => {
                                try {
                                  const result = await client.request(
                                    {
                                      method: "tools/call",
                                      params: { name: tool.name, arguments: args },
                                    },
                                    { signal: callSignal, timeout: 10000 },
                                  );

                                  if (
                                    !result.isError &&
                                    output !== null &&
                                    !output(result.structuredContent)
                                  )
                                    throw new Error("Invalid structured output.");

                                  return toolResult(result, toolBytes, Object.values(env));
                                } catch (cause) {
                                  if (cause instanceof MCPError) throw cause;
                                  connection.state = "unavailable";
                                  connection.diagnostic =
                                    "Connection or protocol failed after dispatch; effects may be unknown. Restart to reconnect. No call was retried.";
                                  await close(connection);
                                  throw new MCPError({
                                    reason: "tool-uncertain",
                                    message: `MCP ${config.id}/${tool.name}: ${connection.diagnostic}`,
                                  });
                                }
                              },
                              catch: (cause) =>
                                cause instanceof MCPError
                                  ? cause
                                  : new MCPError({
                                      reason: "tool-uncertain",
                                      message: `MCP ${config.id}/${tool.name}: effects may be unknown. The call was not retried.`,
                                    }),
                            }),
                          };
                        },
                        catch: () =>
                          new MCPError({
                            reason: "tool-arguments",
                            message: `MCP ${config.id}/${tool.name}: input must contain a JSON object matching the original input schema.`,
                          }),
                      }),
                  });
                }

                const missing = config.tools.filter((name) => !names.has(name));

                if (missing.length > 0)
                  throw new MCPDiagnostic({
                    message: "An allowlisted tool was not discovered. Check tools in config.json.",
                  });

                return tools;
              },
              catch: (cause) =>
                failed(
                  `MCP ${config.id}: ${cause instanceof MCPDiagnostic ? cause.message : "Startup or protocol failed. Check the executable and server compatibility."}`,
                ),
            });
          }).pipe(Effect.timeout("8 seconds"));

          yield* startup.pipe(
            Effect.tap((tools) =>
              Effect.sync(() => {
                connection.tools = tools;
                connection.state = "connected";
              }),
            ),
            Effect.catch((error) =>
              Effect.gen(function* () {
                connection.state = "unavailable";
                connection.diagnostic = `${error instanceof MCPError ? error.message : `MCP ${config.id}: startup timed out.`} Restart to reconnect.`;
                yield* Effect.promise(() => close(connection));
                yield* Console.error(connection.diagnostic);
              }),
            ),
            Effect.onInterrupt(() => Effect.promise(() => close(connection))),
          );

          return connection;
        }).pipe(lock.withPermit);

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
          Effect.gen(function* () {
            const allowed: MCPTool[] = [];

            for (const config of servers) {
              if (!config.enabled || (scheduled && (config.scheduledTools?.length ?? 0) === 0))
                continue;
              const connection = yield* connect(config);

              if (connection.state !== "connected") continue;
              allowed.push(
                ...connection.tools.filter(
                  (tool) => !scheduled || config.scheduledTools?.includes(tool.toolName),
                ),
              );
            }

            return allowed;
          }),
      };
    }),
  );
