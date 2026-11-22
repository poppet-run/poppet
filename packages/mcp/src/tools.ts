import { InsufficientScopeError, type Tool as ServerTool } from "@modelcontextprotocol/client";
import type { Tool } from "@poppet/provider";
import { Effect, Ref, Schema } from "effect";

import {
  compileSchema,
  containsSecret,
  decodeArguments,
  definition,
  toolResult,
} from "#src/catalog";
import { isHTTPServer, type MCPServer } from "#src/config";
import {
  diagnostic,
  failed,
  invalidateConnection,
  MCPDiagnostic,
  startupFailure,
  UnsupportedTool,
  type Connection,
} from "#src/connection";
import { MCPError } from "#src/errors";
import { ReviewedAccountChanged, reviewedHTTPRequest } from "#src/transport";

export interface MCPTool {
  readonly definition: Tool;
  readonly serverId: string;
  readonly toolName: string;
  readonly availableAfterUntrusted: boolean;
  readonly review?: { readonly origin: string | null } | undefined;
  readonly prepare: (argumentsJSON: string) => Effect.Effect<
    {
      readonly execute: Effect.Effect<string, MCPError>;
      readonly validatedArguments?: string;
    },
    MCPError
  >;
}

const compile = (input: Schema.JsonObject, tool: string, kind: "input" | "output") => {
  try {
    return compileSchema(input);
  } catch {
    throw new UnsupportedTool({
      message: `Unsupported ${kind} schema for tool ${JSON.stringify(tool)}. Use draft-07 or 2020-12 JSON Schema, at most 16 KiB, depth 32 and 1024 nodes; patterns must be supported by RE2. References, patternProperties and unknown formats or keywords are unsupported.`,
    });
  }
};

export const makeTool = (
  config: MCPServer,
  tool: ServerTool,
  connection: Connection<MCPTool>,
  secrets: () => ReadonlyArray<string>,
  toolBytes: number,
): MCPTool => {
  if ((tool.description?.length ?? 0) > 4096 || tool.execution?.taskSupport === "required")
    throw new UnsupportedTool({
      message: `Tool ${JSON.stringify(tool.name)} has a description over 4096 characters or requires unsupported task execution.`,
    });

  if (
    secrets().length > 0 &&
    containsSecret(Schema.decodeUnknownSync(Schema.JsonObject)(tool), secrets())
  )
    throw new MCPDiagnostic({ message: "Tool definition contains a selected credential." });
  const schema = Schema.decodeUnknownSync(Schema.JsonObject)(tool.inputSchema);

  if (schema.type !== "object")
    throw new UnsupportedTool({
      message: `Tool ${JSON.stringify(tool.name)} input must be an object schema.`,
    });
  const validate = compile(schema, tool.name, "input");

  const output =
    tool.outputSchema === undefined
      ? null
      : compile(
          Schema.decodeUnknownSync(Schema.JsonObject)(tool.outputSchema),
          tool.name,
          "output",
        );

  const uncertain = () =>
    new MCPError({
      reason: "tool-uncertain",
      message: `MCP ${config.id}/${tool.name}: Connection or protocol failed after dispatch; effects may be unknown. No call was retried; Poppet reconnects on a later request.`,
    });

  const reviewed = config.reviewedTools?.includes(tool.name) === true;
  const endpoint = isHTTPServer(config) ? config.url : null;

  const execute = (args: Schema.JsonObject, token?: string) =>
    Effect.gen(function* () {
      if (Ref.getUnsafe(connection.state).status !== "connected")
        return yield* Effect.fail(
          failed(diagnostic(connection) ?? `MCP ${config.id} is unavailable.`),
        );

      const result = yield* Effect.tryPromise({
        try: (signal) => {
          const send = () =>
            connection.client.request(
              { method: "tools/call", params: { name: tool.name, arguments: args } },
              { signal, timeout: 10000 },
            );

          return reviewed && endpoint !== null
            ? reviewedHTTPRequest(endpoint, token, send)
            : send();
        },
        catch: (cause) => {
          if (cause instanceof ReviewedAccountChanged)
            return new MCPError({
              reason: "tool-permission",
              message:
                "The MCP sign-in changed after preparation. Nothing was sent. Request the action again.",
            });

          if (connection.signIn?.required() === true) return failed(connection.signIn.message);

          if (cause instanceof InsufficientScopeError) {
            const scope =
              cause.requiredScope !== undefined &&
              cause.requiredScope.length <= 128 &&
              /^[A-Za-z0-9._:/+-]+(?: [A-Za-z0-9._:/+-]+)*$/.test(cause.requiredScope)
                ? cause.requiredScope
                : undefined;

            return new MCPError({
              reason: "tool-permission",
              message: `MCP ${config.id}/${tool.name}: the server requires ${scope === undefined ? "additional scope" : `the scope ${scope}`}. Add it to oauth.scopes and run poppet mcp login ${config.id}.`,
            });
          }

          return uncertain();
        },
      });

      return yield* Effect.try({
        try: () => {
          if (!result.isError && output !== null && !output(result.structuredContent))
            throw new Error("Invalid structured output.");

          return toolResult(result, reviewed ? toolBytes - 128 : toolBytes, secrets());
        },
        catch: (cause) => (cause instanceof MCPError ? cause : uncertain()),
      });
    }).pipe(
      Effect.tapError((error) =>
        error.reason === "tool-uncertain" || connection.signIn?.required() === true
          ? Effect.promise(() => invalidateConnection(connection, error.message))
          : Effect.void,
      ),
      Effect.onInterrupt(() =>
        Effect.promise(() => invalidateConnection(connection, uncertain().message)),
      ),
    );

  return {
    serverId: config.id,
    toolName: tool.name,
    availableAfterUntrusted: config.availableAfterUntrusted === true,
    review: reviewed ? { origin: endpoint === null ? null : new URL(endpoint).origin } : undefined,
    definition: definition(config.id, tool.name, tool.description ?? "", schema),
    prepare: (argumentsJSON) =>
      Effect.try({
        try: () => {
          const args = decodeArguments(argumentsJSON);

          if (!validate(args)) throw new Error("Arguments do not match schema.");

          if (!reviewed) return { execute: execute(args) };

          if (
            containsSecret(
              args,
              secrets().filter((secret) => secret.length > 0),
            )
          )
            throw new Error("Reviewed arguments contain a selected credential.");

          return {
            validatedArguments: JSON.stringify(args),
            execute: execute(args, connection.token()),
          };
        },
        catch: () =>
          new MCPError({
            reason: "tool-arguments",
            message: `MCP ${config.id}/${tool.name}: input must contain a JSON object matching the original input schema.`,
          }),
      }),
  };
};

export const buildTools = (
  config: MCPServer,
  discovered: ReadonlyArray<ServerTool>,
  connection: Connection<MCPTool>,
  secrets: () => ReadonlyArray<string>,
  toolBytes: number,
) => {
  const skipped: string[] = [];

  return Effect.try({
    try: () => {
      const tools = discovered
        .filter((tool) => config.tools.includes(tool.name))
        .flatMap((tool) => {
          try {
            return [makeTool(config, tool, connection, secrets, toolBytes)];
          } catch (cause) {
            if (!(cause instanceof UnsupportedTool)) throw cause;
            skipped.push(cause.message);

            return [];
          }
        });

      return { tools, skipped };
    },
    catch: (cause) => startupFailure(config, cause),
  });
};
