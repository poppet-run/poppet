import { AppConfig, readConfigFile, updateConfigFile } from "@poppet/config";
import { ApiKeyStore } from "@poppet/credentials";
import { MCPServers, probeServer, type MCPHTTPServer } from "@poppet/mcp";
import { CredentialInput } from "@poppet/provider";
import { Console, Effect, Option, Schema, type Types } from "effect";

import { UsageError } from "#src/commands/errors";

export interface AddServer {
  readonly id: string;
  readonly url: string;
  readonly auth: "none" | "api-key";
  readonly tools: ReadonlyArray<string>;
  readonly scheduledTools: ReadonlyArray<string>;
  readonly header: string;
  readonly prefix: string;
  readonly keyStdin: boolean;
}

/** Saved MCP keys share the protected auth directory, so the prefix keeps them apart from providers. */
const credentialName = (id: string) => `mcp-${id}`;

const restart = "Restart the worker to use this change.";

const invalid = (message: string) => Effect.fail(new UsageError({ message }));

/** Validates the whole server list as config.json would, before anything is saved. */
const checkServers = (servers: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(MCPServers, { onExcessProperty: "error" })(servers).pipe(
    Effect.mapError(
      () =>
        new UsageError({
          message:
            "The server cannot be added. Use a unique lowercase ID, at most 8 servers, an https URL (or http to loopback) without credentials, valid header names, and scheduled tools that are also allowed tools.",
        }),
    ),
  );

export const addMCPServer = (options: AddServer) =>
  Effect.gen(function* () {
    const { dataDirectory } = yield* AppConfig;
    const { file } = yield* readConfigFile(dataDirectory);
    const existing = file.mcpServers ?? [];
    const credential = credentialName(options.id);

    if (options.auth === "api-key" && credential.length > 64)
      return yield* invalid("Use a server ID of at most 60 characters with --auth api-key.");

    if (options.auth !== "api-key" && options.keyStdin)
      return yield* invalid("--key-stdin applies only to --auth api-key.");

    const entry: Types.Mutable<MCPHTTPServer> = {
      id: options.id,
      enabled: true,
      url: options.url,
      tools: options.tools,
    };

    if (options.auth === "api-key")
      entry.headers = { [options.header]: { credential, prefix: options.prefix } };

    if (options.scheduledTools.length > 0) entry.scheduledTools = options.scheduledTools;

    if (existing.some((server) => server.id === options.id))
      return yield* invalid(`MCP server ${options.id} already exists. Remove it first.`);
    yield* checkServers([...existing, entry]);

    // The key is saved first so the entry never names a missing credential; a failed
    // configuration write removes it again.
    if (options.auth === "api-key") {
      const key = yield* CredentialInput.use((input) =>
        input.readKey(credential, options.keyStdin),
      );

      yield* ApiKeyStore.use((store) => store.write(credential, key));
    }

    yield* updateConfigFile(dataDirectory, (current) => ({
      ...current,
      mcpServers: [...(current.mcpServers ?? []), entry],
    })).pipe(
      Effect.tapError(() =>
        options.auth === "api-key"
          ? ApiKeyStore.use((store) => store.remove(credential)).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
    yield* Console.log(`Saved MCP server ${options.id}.`);

    const discovered = yield* probeServer(entry).pipe(
      Effect.tapError((error) => Console.error(error.message)),
      Effect.option,
    );

    if (Option.isSome(discovered))
      yield* Console.log(
        discovered.value.length === 0
          ? "The server offers no tools."
          : `Available tools: ${discovered.value.join(", ")}`,
      );

    yield* Console.log(
      options.tools.length === 0
        ? `No tools are allowed yet. Review the names, then add them to tools for ${options.id} in config.json. ${restart}`
        : `Allowed tools: ${options.tools.join(", ")}. ${restart}`,
    );
  });

export const removeMCPServer = (id: string) =>
  Effect.gen(function* () {
    const { dataDirectory } = yield* AppConfig;
    const { file } = yield* readConfigFile(dataDirectory);

    if (!(file.mcpServers ?? []).some((server) => server.id === id))
      return yield* invalid(`Unknown MCP server ${id}. Use mcp servers to find its ID.`);

    yield* updateConfigFile(dataDirectory, (current) => ({
      ...current,
      mcpServers: (current.mcpServers ?? []).filter((server) => server.id !== id),
    }));

    // Only the credential named by mcp add belongs to this server; owner-provisioned
    // references may be shared and are left in place.
    if (credentialName(id).length <= 64)
      yield* ApiKeyStore.use((store) => store.remove(credentialName(id)));
    yield* Console.log(`Removed MCP server ${id}. ${restart}`);
  });
