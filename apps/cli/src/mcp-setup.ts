import { AppConfig, readConfigFile, updateConfigFile } from "@poppet/config";
import { ApiKeyStore } from "@poppet/credentials";
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
  readonly tools: ReadonlyArray<string>;
  /** Allows every tool the server lists now, saved as explicit names. */
  readonly allTools: boolean;
  readonly scheduledTools: ReadonlyArray<string>;
  readonly header: string;
  readonly prefix: string;
  readonly keyStdin: boolean;
  readonly clientId: Option.Option<string>;
  readonly scopes: ReadonlyArray<string>;
  readonly callbackPort: Option.Option<number>;
  readonly login: boolean;
  readonly openBrowser: boolean;
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

    if (
      options.auth !== "oauth" &&
      (Option.isSome(options.clientId) ||
        options.scopes.length > 0 ||
        Option.isSome(options.callbackPort))
    )
      return yield* invalid("--client-id, --scope and --callback-port apply only to --auth oauth.");

    if (options.allTools && options.tools.length > 0)
      return yield* invalid("Use either --all-tools or --tool.");

    if (options.allTools && options.auth === "oauth" && !options.login)
      return yield* invalid("--all-tools needs sign-in to list tools; omit --no-login.");

    const entry: Types.Mutable<MCPHTTPServer> = {
      id: options.id,
      enabled: true,
      url: options.url,
      tools: options.tools,
    };

    if (options.auth === "api-key")
      entry.headers = { [options.header]: { credential, prefix: options.prefix } };

    // With --all-tools, scheduled tools are saved once discovery confirms they exist.
    if (options.scheduledTools.length > 0 && !options.allTools)
      entry.scheduledTools = options.scheduledTools;

    if (options.auth === "oauth") {
      const oauth: Types.Mutable<MCPOAuthServer["oauth"]> = {};

      if (Option.isSome(options.clientId)) oauth.clientId = options.clientId.value;

      if (options.scopes.length > 0) oauth.scopes = options.scopes;

      if (Option.isSome(options.callbackPort)) oauth.callbackPort = options.callbackPort.value;
      entry.oauth = oauth;
    }

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

    if (isOAuthServer(entry)) {
      if (!options.login) {
        yield* Console.log(`Run poppet mcp login ${options.id} to sign in. ${restart}`);

        return;
      }

      // A failed sign-in keeps the entry so the owner can retry with mcp login.
      const signedIn = yield* login(entry, options.openBrowser).pipe(
        Effect.tapError((error) =>
          Console.error(`${error.message} Run poppet mcp login ${options.id} to try again.`),
        ),
        Effect.option,
      );

      if (Option.isNone(signedIn)) return;
    }

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

    const allowed = options.allTools
      ? yield* allowDiscovered(dataDirectory, options, Option.getOrNull(discovered))
      : options.tools;

    yield* Console.log(
      allowed.length === 0
        ? `No tools are allowed yet. Review the names, then add them to tools for ${options.id} in config.json. ${restart}`
        : `Allowed tools: ${allowed.join(", ")}. ${restart}`,
    );
  });

/** Saves every discovered name as an explicit allowlist; later server additions stay unallowed. */
const allowDiscovered = (
  dataDirectory: string,
  options: AddServer,
  discovered: ReadonlyArray<string> | null,
) =>
  Effect.gen(function* () {
    if (discovered === null || discovered.length === 0) return [];

    const missing = options.scheduledTools.filter((name) => !discovered.includes(name));

    if (missing.length > 0) {
      yield* Console.error(
        `The server does not offer ${missing.join(", ")}, so no tools were allowed.`,
      );

      return [];
    }

    yield* updateConfigFile(dataDirectory, (current) => {
      const servers = current.mcpServers ?? [];
      const index = servers.findIndex((server) => server.id === options.id);

      if (index === -1) return current;

      const allowed = { ...servers[index]!, tools: discovered };

      const updated =
        options.scheduledTools.length === 0
          ? allowed
          : { ...allowed, scheduledTools: options.scheduledTools };

      return { ...current, mcpServers: servers.with(index, updated) };
    });

    return discovered;
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
export const loginMCPServer = (id: string, browser: boolean) =>
  oauthServer(id).pipe(Effect.flatMap((server) => login(server, browser)));

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
