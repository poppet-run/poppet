import { describe, expect, test } from "bun:test";

import { ApiKeyStore } from "@poppet/credentials";
import { Clock, ConfigProvider, Console, Effect, Layer, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";

import { type MCPHTTPServer } from "#src/config";
import { MCP, makeMCPLive } from "#src/service";
import { NoSignInsLive } from "#src/test/sign-ins";

const Request = Schema.Struct({
  id: Schema.optionalKey(Schema.Json),
  method: Schema.String,
  params: Schema.optionalKey(Schema.JsonObject),
});

interface Event {
  readonly http: string;
  readonly method: string | null;
  readonly session: string | null;
  readonly authorization: string | null;
}

const inputSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  additionalProperties: false,
};

/** An in-process Streamable HTTP server that answers with JSON bodies or SSE streams. */
const serve = (mode: "json" | "sse" | "oversized" | "oversized-sse" | "redirect" = "json") => {
  const events: Event[] = [];
  let sessions = 0;
  const elsewhere = { requests: 0 };

  const other = Bun.serve({
    hostname: "localhost",
    port: 0,
    fetch: () => {
      elsewhere.requests++;

      return new Response(null, { status: 500 });
    },
  });

  const respond = (message: Schema.JsonObject, headers: Record<string, string> = {}) => {
    const body = JSON.stringify(message);

    // Large comment events before each message exceed the cap together but not one by one.
    const padding = mode === "sse" ? `: ${"x".repeat(200000)}\n\n`.repeat(2) : "";

    return mode === "sse" || mode === "oversized-sse"
      ? new Response(`${padding}event: message\ndata: ${body}\n\n`, {
          headers: { "content-type": "text/event-stream", ...headers },
        })
      : new Response(body, { headers: { "content-type": "application/json", ...headers } });
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const record = (method: string | null) =>
        events.push({
          http: request.method,
          method,
          session: request.headers.get("mcp-session-id"),
          authorization: request.headers.get("authorization"),
        });

      if (request.method !== "POST") {
        record(null);

        return new Response(null, { status: request.method === "DELETE" ? 200 : 405 });
      }

      const message = Schema.decodeUnknownSync(Schema.fromJsonString(Request))(
        await request.text(),
      );

      record(message.method);

      if (mode === "redirect")
        return new Response(null, {
          status: 307,
          headers: { location: `http://localhost:${other.port}/mcp` },
        });

      if (message.id === undefined) return new Response(null, { status: 202 });

      const reply = (result: Schema.JsonObject, headers?: Record<string, string>) =>
        respond({ jsonrpc: "2.0", id: message.id!, result }, headers);

      if (message.method === "initialize")
        return reply(
          {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          },
          { "mcp-session-id": `session-${++sessions}` },
        );

      if (message.method === "tools/list")
        return mode === "oversized" || mode === "oversized-sse"
          ? reply({ tools: [], padding: "x".repeat(300000) })
          : reply({
              tools: ["read", "fail"].map((name) => ({
                name,
                description: "Fixture tool",
                inputSchema,
              })),
            });

      if (message.params?.name === "fail") return new Response("failed", { status: 500 });

      return reply({
        content: [{ type: "text", text: `seen ${request.headers.get("x-selected")}` }],
        structuredContent: {
          arguments: message.params?.arguments ?? {},
          authorization: request.headers.get("authorization"),
        },
      });
    },
  });

  return {
    events,
    elsewhere,
    url: `http://127.0.0.1:${server.port}/mcp`,
    stop: async () => {
      await server.stop(true);
      await other.stop(true);
    },
  };
};

const layer = (url: string, headers: MCPHTTPServer["headers"] = {}, tools = ["read"]) => {
  const server: MCPHTTPServer = { id: "remote", enabled: true, url, headers, tools };

  return makeMCPLive(16384).pipe(
    Layer.provide([
      NoSignInsLive,
      Layer.succeed(ApiKeyStore, {
        read: (name) => {
          expect(name).toBe("remote");

          return Effect.succeed(Redacted.make("saved-mcp-secret"));
        },
        write: () => Effect.die("Unexpected credential write"),
        remove: () => Effect.die("Unexpected credential deletion"),
      }),
      ConfigProvider.layer(ConfigProvider.fromUnknown({ mcpServers: JSON.stringify([server]) })),
    ]),
  );
};

const quiet = Effect.provideService(Console.Console, { ...console, error: () => {} });

const call = (name = "read") =>
  Effect.gen(function* () {
    const tool = (yield* (yield* MCP).snapshot(false)).find((each) => each.toolName === name)!;

    return yield* tool
      .prepare('{"input":"{}"}')
      .pipe(Effect.flatMap((prepared) => prepared.execute));
  });

describe("MCP over HTTP", () => {
  test.each(["json", "sse"] as const)(
    "when a server answers with %s, sends selected headers in its session, redacts them, and ends the session",
    async (mode) => {
      const previous = process.env.POPPET_MCP_SELECTED;
      process.env.POPPET_MCP_SELECTED = "selected-mcp-secret";
      const server = serve(mode);

      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const mcp = yield* MCP;
            expect((yield* mcp.status)[0]).toMatchObject({ state: "idle", transport: "http" });
            expect(server.events).toEqual([]);
            const result = yield* call();
            expect(result).toContain("[REDACTED]");
            expect(result).not.toContain("secret");
            const status = (yield* mcp.status)[0]!;
            expect(status).toMatchObject({
              state: "connected",
              transport: "http",
              origin: new URL(server.url).origin,
              pid: null,
              availableTools: ["read"],
            });
            expect(JSON.stringify(status)).not.toContain("secret");
          }).pipe(
            Effect.provide(
              layer(server.url, {
                Authorization: { credential: "remote", prefix: "Bearer " },
                "X-Selected": { env: "POPPET_MCP_SELECTED" },
              }),
            ),
          ),
        );

        const posts = server.events.filter((event) => event.http === "POST");
        expect(posts.map((event) => event.method)).toEqual([
          "initialize",
          "notifications/initialized",
          "tools/list",
          "tools/call",
        ]);
        expect(posts.every((event) => event.authorization === "Bearer saved-mcp-secret")).toBe(
          true,
        );
        expect(posts.slice(1).every((event) => event.session === "session-1")).toBe(true);
        expect(server.events.at(-1)).toMatchObject({ http: "DELETE", session: "session-1" });
      } finally {
        if (previous === undefined) delete process.env.POPPET_MCP_SELECTED;
        else process.env.POPPET_MCP_SELECTED = previous;
        await server.stop();
      }
    },
  );

  test.each(["oversized", "oversized-sse", "redirect"] as const)(
    "when the server's response is %s, rejects discovery and leaves the catalog empty",
    async (mode) => {
      const server = serve(mode);

      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            expect(yield* (yield* MCP).snapshot(false)).toEqual([]);
            expect((yield* (yield* MCP).status)[0]).toMatchObject({
              state: "unavailable",
              diagnostic: expect.stringContaining("Check the URL"),
            });
          }).pipe(Effect.provide(layer(server.url)), quiet),
        );
        expect(server.elsewhere.requests).toBe(0);
      } finally {
        await server.stop();
      }
    },
  );

  test("when a dispatched call fails, reports an uncertain call and reconnects after backoff without replaying it", async () => {
    const server = serve();

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const mcp = yield* MCP;
          yield* TestClock.setTime(1_000_000);
          expect(yield* call("fail").pipe(Effect.flip)).toHaveProperty("reason", "tool-uncertain");
          const failedAt = yield* Clock.currentTimeMillis;
          expect((yield* mcp.status)[0]).toMatchObject({
            state: "unavailable",
            retryAt: failedAt + 30_000,
          });
          yield* TestClock.adjust(29_999);
          expect(yield* mcp.snapshot(false)).toEqual([]);
          yield* TestClock.adjust(1);
          expect(yield* mcp.snapshot(false)).toHaveLength(2);
          expect((yield* mcp.status)[0]).toMatchObject({ state: "connected", retryAt: null });
        }).pipe(
          Effect.provide(layer(server.url, {}, ["read", "fail"])),
          Effect.provide(TestClock.layer()),
          quiet,
        ),
      );

      expect(server.events.filter((event) => event.method === "tools/call")).toHaveLength(1);
      // The failed session ends before its replacement starts.
      expect(
        server.events
          .filter((event) => event.http === "DELETE" || event.method === "initialize")
          .map((event) => (event.http === "DELETE" ? `end ${event.session}` : "initialize")),
      ).toEqual(["initialize", "end session-1", "initialize", "end session-2"]);
    } finally {
      await server.stop();
    }
  });
});
