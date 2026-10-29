import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApiKeyStore } from "@poppet/credentials";
import { ProviderEnvironment } from "@poppet/provider";
import { ConfigProvider, Console, Effect, Layer } from "effect";

import type { MCPHTTPServer } from "#src/config";
import {
  MCPSignIns,
  MCPSignInsLive,
  runtimeAuthorization,
  signIn,
  type MCPOAuthServer,
} from "#src/oauth";
import { MCP, makeMCPLive } from "#src/service";
import { serveOAuth, type OAuthFixtureOptions } from "#src/test/oauth-server";

const quiet = Effect.provideService(Console.Console, {
  ...console,
  log: () => {},
  error: () => {},
  warn: () => {},
});

const harness = async (options: OAuthFixtureOptions = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-mcp-oauth-"));
  const server = serveOAuth(options);
  const opened: string[] = [];

  const config: MCPOAuthServer = {
    id: "remote",
    enabled: true,
    url: server.url,
    oauth: {},
    tools: ["read"],
  };

  const signIns = MCPSignInsLive.pipe(
    Layer.provide(
      Layer.succeed(ProviderEnvironment, { applicationName: "Test", dataDirectory: directory }),
    ),
  );

  const services = Layer.merge(
    signIns,
    Layer.succeed(ApiKeyStore, {
      read: () => Effect.die("Unexpected credential read"),
      write: () => Effect.die("Unexpected credential write"),
      remove: () => Effect.die("Unexpected credential deletion"),
    }),
  );

  const mcp = (servers: ReadonlyArray<MCPHTTPServer> = [config]) =>
    makeMCPLive(16384).pipe(
      Layer.provide([
        services,
        ConfigProvider.layer(ConfigProvider.fromUnknown({ mcpServers: JSON.stringify(servers) })),
      ]),
    );

  // A consenting browser follows the authorization redirect to the loopback callback.
  const login = signIn(config, {
    noBrowser: false,
    remote: false,
    paste: Effect.never,
    open: (url) =>
      Effect.promise(async () => {
        opened.push(url);
        await fetch(await server.approve(new URL(url)));
      }),
    timeoutMs: 5000,
    now: Date.now,
  });

  return {
    server,
    config,
    opened,
    mcp,
    run: <A, E>(program: Effect.Effect<A, E, MCPSignIns | ApiKeyStore>) =>
      Effect.runPromise(program.pipe(Effect.provide(services), quiet)),
    login: () => Effect.runPromise(login.pipe(Effect.provide(services), quiet)),
    close: async () => {
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
};

const call = Effect.gen(function* () {
  const [tool] = yield* (yield* MCP).snapshot(false);

  return yield* tool!
    .prepare('{"input":"{}"}')
    .pipe(Effect.flatMap((prepared) => prepared.execute));
});

describe("MCP OAuth", () => {
  test("when the owner signs in, calls tools, refreshes an expired token, and redacts tokens from results", async () => {
    const state = await harness({ tokenUses: 1 });

    try {
      await state.login();
      expect(state.opened).toHaveLength(1);
      expect(state.server.registrations.count).toBe(1);

      const results = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const first = yield* call;
            // The fixture accepts each access token once, so this call refreshes first.
            const second = yield* call;
            const status = yield* (yield* MCP).status;

            return { first, second, status };
          }),
        ).pipe(Effect.provide(state.mcp()), quiet),
      );

      expect(results.first).toContain("[REDACTED]");
      expect(results.first).not.toContain("access-");
      expect(results.second).toContain("[REDACTED]");
      expect(state.server.events.filter((event) => event.path === "/token")).toHaveLength(2);
      expect(results.status[0]).toMatchObject({
        state: "connected",
        signIn: { signedIn: true, scopes: ["read"] },
      });
      expect(state.opened).toHaveLength(1);
    } finally {
      await state.close();
    }
  });

  test("when refresh is rejected, waits for sign-in without opening a browser and reconnects after login", async () => {
    const state = await harness();

    try {
      await state.login();
      state.server.options.tokenUses = 0;
      state.server.options.refreshError = "invalid_grant";

      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const mcp = yield* MCP;
            const failure = yield* Effect.flip(mcp.tools("remote"));
            const waiting = yield* mcp.status;

            // Another process signs in again; the next request reconnects without a backoff.
            delete state.server.options.tokenUses;
            delete state.server.options.refreshError;
            yield* Effect.promise(() => state.login());
            const tools = yield* mcp.tools("remote");

            return { failure, waiting, tools };
          }),
        ).pipe(Effect.provide(state.mcp()), quiet),
      );

      expect(result.failure.message).toContain("Run poppet mcp login remote.");
      expect(result.waiting[0]).toMatchObject({
        state: "needs-login",
        retryAt: null,
        signIn: { signedIn: false },
      });
      expect(result.tools.map((tool) => tool.toolName)).toEqual(["read"]);
      expect(state.opened).toHaveLength(2);
    } finally {
      await state.close();
    }
  });

  test("when two processes refresh the same token at once, spends the refresh token once and both keep a valid token", async () => {
    const state = await harness({ tokenUses: 1 });

    try {
      await state.login();

      // Two runtime authorizations stand in for the worker and a CLI process.
      const [first, second] = await state.run(
        Effect.all([
          runtimeAuthorization(state.config, Date.now),
          runtimeAuthorization(state.config, Date.now),
        ]),
      );

      const context = {
        response: new Response(null, { status: 401 }),
        serverUrl: new URL(state.server.url),
        fetchFn: fetch,
      };

      await Promise.all([
        first!.authProvider.onUnauthorized!(context),
        second!.authProvider.onUnauthorized!(context),
      ]);

      expect(first!.token()).toBe(second!.token());
      expect(first!.loginRequired() || second!.loginRequired()).toBe(false);
      expect(state.server.events.filter((event) => event.path === "/token")).toHaveLength(2);
    } finally {
      await state.close();
    }
  });

  test("when the configured URL changes or a server asks for more scope, requires sign-in without opening a browser", async () => {
    const state = await harness({ stepUpScope: "admin" });

    try {
      await state.login();

      const moved = { ...state.config, url: state.server.url.replace("/mcp", "/other") };

      const statuses = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const mcp = yield* MCP;
            yield* Effect.flip(mcp.tools("remote"));

            return yield* mcp.status;
          }),
        ).pipe(Effect.provide(state.mcp([moved])), quiet),
      );

      expect(statuses[0]).toMatchObject({ state: "needs-login", signIn: { signedIn: false } });

      const stepUp = await Effect.runPromise(
        Effect.scoped(Effect.flip(call)).pipe(Effect.provide(state.mcp()), quiet),
      );

      expect(stepUp.reason).not.toBe("tool-uncertain");
      expect(stepUp.message).toContain("admin");
      expect(state.opened).toHaveLength(1);
    } finally {
      await state.close();
    }
  });
});
