import { AppConfig, readConfigFile, updateConfigFile } from "@poppet/config";
import { ApiKey, ApiKeyStore } from "@poppet/credentials";
import {
  forgetSignIn,
  isHTTPServer,
  isOAuthServer,
  MCPServers,
  probeServer,
  signIn,
  signOut,
  type MCPHTTPServer,
  type MCPOAuthServer,
} from "@poppet/mcp";
import { CredentialInput } from "@poppet/provider";
import { openBrowser, remoteSession } from "@poppet/sign-in";
import { Clock, Console, Effect, Option, Schema, type Types } from "effect";

import { readVisibleLine } from "#src/api-key-input";
import { UsageError } from "#src/commands/errors";

export interface AddServer {
  readonly id: string;
  readonly url: string;
  readonly auth: "none" | "api-key" | "oauth";
  readonly apiKey: Option.Option<string>;
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

    if (options.auth !== "api-key" && Option.isSome(options.apiKey))
      return yield* invalid("--api-key applies only to --auth api-key.");

    const entry: Types.Mutable<MCPHTTPServer> = {
      id: options.id,
      enabled: true,
      url: options.url,
      tools: [],
    };

    if (options.auth === "api-key")
      entry.headers = { Authorization: { credential, prefix: "Bearer " } };

    if (options.auth === "oauth") entry.oauth = {};

    if (existing.some((server) => server.id === options.id))
      return yield* invalid(`MCP server ${options.id} already exists. Remove it first.`);
    yield* checkServers([...existing, entry]);

    // The key is saved first so the entry never names a missing credential; a failed
    // configuration write removes it again.
    if (options.auth === "api-key") {
      const key = yield* Option.isSome(options.apiKey)
        ? Schema.decodeUnknownEffect(ApiKey)(options.apiKey.value).pipe(
            Effect.mapError(
              () => new UsageError({ message: "Enter a nonempty API key without whitespace." }),
            ),
          )
        : CredentialInput.use((input) => input.readKey(credential, false));

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

    yield* Console.log(
      `${isOAuthServer(entry) ? `Run poppet mcp login ${options.id} to sign in. ` : ""}Run poppet mcp tools ${options.id} to discover tools, then poppet mcp allow ${options.id} <tools...>. ${restart}`,
    );
  });

export const changeMCPPermissions = (options: {
  readonly id: string;
  readonly action: "allow" | "deny";
  readonly tools: ReadonlyArray<string>;
  readonly all: boolean;
  readonly scheduled: boolean;
}) =>
  Effect.gen(function* () {
    if (options.all && options.tools.length > 0)
      return yield* invalid("Use either tool names or --all.");

    if (!options.all && options.tools.length === 0)
      return yield* invalid("Specify at least one tool name or use allow --all.");

    if (options.all && options.scheduled)
      return yield* invalid(
        "Name reviewed tools explicitly with --scheduled; --all grants interactive access only.",
      );

    const { dataDirectory } = yield* AppConfig;
    const { file } = yield* readConfigFile(dataDirectory);
    const server = file.mcpServers?.find((entry) => entry.id === options.id);

    if (server === undefined)
      return yield* invalid(`Unknown MCP server ${options.id}. Use mcp servers to find its ID.`);

    let names = [...new Set(options.tools)];

    if (options.action === "allow") {
      if (!server.enabled) return yield* invalid(`MCP server ${options.id} is disabled.`);
      const discovered = yield* probeServer(server);

      if (options.all) names = [...discovered];
      else if (names.some((name) => !discovered.includes(name)))
        return yield* invalid(
          "One or more requested tools were not discovered; no permissions changed.",
        );
    }

    let changed = false;
    yield* updateConfigFile(dataDirectory, (current) => {
      const servers = current.mcpServers ?? [];
      const index = servers.findIndex((entry) => entry.id === options.id);
      const entry = servers[index];

      // Discovery authorizes names only for the exact configuration we inspected.
      if (entry === undefined || JSON.stringify(entry) !== JSON.stringify(server)) return current;
      const scheduled = entry.scheduledTools ?? [];

      const updated =
        options.action === "allow"
          ? {
              ...entry,
              tools: [...new Set([...entry.tools, ...names])],
              scheduledTools: options.scheduled
                ? [...new Set([...scheduled, ...names])]
                : scheduled,
            }
          : {
              ...entry,
              tools: options.scheduled
                ? entry.tools
                : entry.tools.filter((name) => !names.includes(name)),
              scheduledTools: scheduled.filter((name) => !names.includes(name)),
            };

      changed = true;

      return { ...current, mcpServers: servers.with(index, updated) };
    });

    if (!changed)
      return yield* invalid("The server configuration changed. Retry the permission command.");
    yield* Console.log(`Updated permissions for MCP server ${options.id}. ${restart}`);
  });

const login = (server: MCPOAuthServer, browser: boolean) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;

    yield* signIn(server, {
      noBrowser: !browser,
      remote: remoteSession(process.env, process.platform),
      paste: readVisibleLine(server.id, "Callback URL: "),
      open: openBrowser,
      timeoutMs: 300_000,
      now: () => clock.currentTimeMillisUnsafe(),
    });
    yield* Console.log(`Signed in to MCP server ${server.id}.`);
  });

const oauthServer = (id: string) =>
  Effect.gen(function* () {
    const { dataDirectory } = yield* AppConfig;
    const { file } = yield* readConfigFile(dataDirectory);
    const server = (file.mcpServers ?? []).find((candidate) => candidate.id === id);

    if (server === undefined)
      return yield* invalid(`Unknown MCP server ${id}. Use mcp servers to find its ID.`);

    if (!isHTTPServer(server) || !isOAuthServer(server))
      return yield* invalid(`MCP server ${id} does not use OAuth.`);

    return server;
  });

/** A running worker adopts the new tokens on its next request to this server. */
export const loginMCPServer = (id: string, browser: boolean, callbackPort: Option.Option<number>) =>
  Effect.gen(function* () {
    if (Option.isSome(callbackPort) && (callbackPort.value < 1024 || callbackPort.value > 65535))
      return yield* invalid("--callback-port must be between 1024 and 65535.");

    const server = yield* oauthServer(id);

    const configured = Option.isSome(callbackPort)
      ? { ...server, oauth: { ...server.oauth, callbackPort: callbackPort.value } }
      : server;

    yield* checkServers([configured]);
    yield* login(configured, browser);
  });

export const logoutMCPServer = (id: string) =>
  Effect.gen(function* () {
    yield* oauthServer(id);
    yield* signOut(id);
    yield* Console.log(
      `Removed saved tokens for MCP server ${id}. The authorization server may still list this sign-in until you revoke it there.`,
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
    yield* forgetSignIn(id);
    yield* Console.log(`Removed MCP server ${id}. ${restart}`);
  });
