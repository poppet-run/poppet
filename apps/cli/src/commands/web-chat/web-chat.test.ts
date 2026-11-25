import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentLive,
  ChatSettings,
  defaultPolicy,
  ModelResolver,
  Pages,
  WebSearch,
} from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { gatewaySchema } from "@poppet/gateway";
import { LocalMemoryLive } from "@poppet/memory";
import { invalidRequest } from "@poppet/provider";
import type { ModelOperations } from "@poppet/provider";
import { Store, StoreLive, migrate } from "@poppet/store";
import { taskSchema } from "@poppet/tasks";
import type { SessionList } from "@poppet/web/protocol";
import { Deferred, Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { SqlClient } from "effect/sql";

import { WebChat, WebChatLive } from "#src/commands/web-chat/chat";
import { loadWebAssets, webHandler, WebSettings } from "#src/commands/web-chat/server";
import type { WebAsset } from "#src/commands/web-chat/server";

const accessKey = "test-only-web-chat-key-with-at-least-32-characters";

const settings: WebSettings = {
  origin: "https://chat.example.test",
  hostname: "127.0.0.1",
  port: 8080,
  accessKeyHash: createHash("sha256").update(accessKey).digest("hex"),
};

const storeLayer = (directory: string) => {
  const config = Layer.succeed(AppConfig, {
    applicationName: "Test",
    dataDirectory: directory,
    provider: "test-provider",
    model: "test-model",
  });

  return StoreLive.pipe(Layer.provideMerge(config));
};

const fixture = async (
  directory: string,
  assets: ReadonlyMap<string, WebAsset> = new Map([
    [
      "/index.html",
      {
        type: "text/html",
        body: new TextEncoder().encode("<h1>Poppet</h1>"),
        encoded: new Map(),
        immutable: false,
      },
    ],
  ]),
) => {
  const release = Deferred.makeUnsafe<void>();
  const entered = Deferred.makeUnsafe<void>();
  const state = { calls: 0, fail: false };

  const model: ModelOperations = {
    description: {
      provider: "test-provider",
      id: "test-model",
      name: "Test model",
      capabilities: {
        tools: false,
        images: false,
        generationSettings: [],
        contextWindow: null,
        maxOutputTokens: null,
      },
    },
    stream: () =>
      Stream.concat(
        Stream.fromEffect(
          Effect.sync(() => {
            state.calls++;
          }).pipe(Effect.andThen(Deferred.succeed(entered, undefined))),
        ).pipe(Stream.flatMap(() => Stream.make({ type: "text-delta" as const, text: "Hello" }))),
        Stream.fromEffect(
          Deferred.await(release).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                state.fail
                  ? Effect.fail(invalidRequest("test-provider", "Test failure"))
                  : Effect.succeed({
                      type: "completed" as const,
                      response: {
                        output: [{ type: "text" as const, text: "Hello world" }],
                        continuation: {
                          version: 1 as const,
                          provider: "test-provider",
                          model: "test-model",
                          data: { secret: "provider-only-continuation" },
                        },
                        finishReason: "stop" as const,
                        usage: { inputTokens: 1, outputTokens: 2 },
                      },
                    }),
              ),
            ),
          ),
        ),
      ),
  };

  const store = storeLayer(directory);

  const agent = AgentLive.pipe(
    Layer.provideMerge([
      store,
      LocalMemoryLive.pipe(Layer.provide(store)),
      Layer.succeed(ChatSettings, defaultPolicy),
      Layer.succeed(Pages, { fetch: () => Effect.die("Unexpected fetch") }),
      Layer.succeed(WebSearch, { search: null }),
      Layer.succeed(ModelResolver, { resolve: () => Effect.succeed(model) }),
    ]),
  );

  const runtime = ManagedRuntime.make(WebChatLive.pipe(Layer.provideMerge(agent)));
  const chat = await runtime.runPromise(WebChat);

  const handler = webHandler(settings, chat, assets);

  const send = (path: string, body?: Schema.Json, cookie = "", origin = settings.origin) =>
    handler(
      new Request(`${settings.origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          host: new URL(settings.origin).host,
          origin,
          cookie,
          "content-type": "application/json",
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
    );

  const login = async () => {
    const response = await send("/api/login", { key: accessKey });
    expect(response.status).toBe(200);

    return response.headers.get("set-cookie")!.split(";")[0]!;
  };

  const settled = (id: string) =>
    runtime.runPromise(
      Effect.gen(function* () {
        for (;;) {
          const receipt = yield* chat.receipt(id);

          if (receipt?.status !== "accepted") {
            return receipt;
          }

          yield* Effect.sleep("5 millis");
        }
      }).pipe(Effect.timeout("3 seconds")),
    );

  return { runtime, chat, state, send, handler, login, release, entered, settled };
};

describe("web chat", () => {
  test("when browsing mixed session history after upgrading, filters by the original source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-web-origins-"));

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          for (const [schema, version] of [
            [taskSchema, 5],
            [gatewaySchema, 2],
          ] as const) {
            yield* migrate({
              ...schema,
              version,
              loader: schema.loader.pipe(
                Effect.map((entries) => entries.filter(([id]) => id <= version)),
              ),
            });
          }

          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO sessions (id, provider, model, created_at, updated_at, title_source) VALUES
          ('direct', 'test', 'test', 1, 1, 'fallback'),
          ('renamed-task', 'test', 'test', 2, 5, 'manual'),
          ('old-thread', 'test', 'test', 3, 3, 'generated'),
          ('bound', 'test', 'test', 4, 4, 'generated')`;
          yield* sql`INSERT INTO jobs (id, name, prompt, provider, model, schedule, created_at)
          VALUES ('job', 'Summary', 'Summarise', 'test', 'test', '{}', 0)`;
          yield* sql`INSERT INTO job_occurrences
          (id, job_id, revision, definition, scheduled_at, available_at, status, session_id)
          VALUES ('occ', 'job', 0, '{}', 0, 0, 'completed', 'renamed-task')`;
          yield* sql`INSERT INTO gateway_bindings (adapter, account, scope_id, conversation_id, session_id)
          VALUES ('discord', 'account', 'scope', 'thread', 'bound')`;
          yield* sql`INSERT INTO gateway_inbox (adapter, account, external_id, payload, session_id, run_id, state, occurrence_id) VALUES
          ('slack', 'account', 'reply', '{}', 'old-thread', 'first', 'completed', NULL),
          ('slack', 'account', 'delivery', '{}', 'renamed-task', 'second', 'completed', 'occ')`;
        }).pipe(Effect.provide(storeLayer(directory))),
      );

      const app = await fixture(directory);

      try {
        const cookie = await app.login();

        const list = async (source?: string) => {
          const query = source ? `?source=${encodeURIComponent(source)}` : "";
          const response = await app.send(`/api/session-list${query}`, undefined, cookie);
          expect(response.status).toBe(200);
          const { sessions, gateways }: SessionList = await response.json();
          expect(gateways).toEqual(["discord", "slack"]);

          return sessions.map(({ id }) => id);
        };

        await app.runtime.runPromise(
          Store.use((store) =>
            store.createSession("test", "test", {
              id: "new-task",
              origin: "scheduled",
              taskTitle: "Today's summary",
            }),
          ),
        );
        expect(await list()).toEqual(["direct"]);
        expect(await list("scheduled")).toEqual(["new-task", "renamed-task"]);
        expect(await list("gateway:slack")).toEqual(["old-thread"]);
        expect(await list("gateway:discord")).toEqual(["bound"]);
        expect(await list("all")).toEqual([
          "new-task",
          "renamed-task",
          "bound",
          "old-thread",
          "direct",
        ]);
        expect((await app.send("/api/sessions/renamed-task", undefined, cookie)).status).toBe(200);
      } finally {
        await app.runtime.dispose();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([false, true])(
    "when proxy trust is %j, enforces the applicable login throttle",
    async (trustProxy) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-web-throttle-"));
      const app = await fixture(directory);
      const handler = webHandler({ ...settings, trustProxy }, app.chat, new Map());

      try {
        const limit = trustProxy ? 60 : 10;

        for (let index = 0; index <= limit; index++) {
          const request = new Request(settings.origin + "/api/login", {
            method: "POST",
            headers: {
              host: new URL(settings.origin).host,
              origin: settings.origin,
              "content-type": "application/json",
              "x-forwarded-for": `192.0.2.${index + 1}`,
            },
            body: JSON.stringify({ key: "wrong".repeat(10) }),
          });

          const response = await handler(request, "127.0.0.1");
          expect(response.status).toBe(index < limit ? 401 : 429);
        }
      } finally {
        await app.runtime.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("when all event stream slots are in use, refuses another until a stream closes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-web-stream-cap-"));
    const app = await fixture(directory);
    const streams: Array<Response> = [];

    try {
      const cookie = await app.login();

      const submitted = await app.send(
        "/api/submissions",
        { id: randomUUID(), sessionId: null, text: "Hello" },
        cookie,
      );

      const { sessionId } = Schema.decodeUnknownSync(Schema.Struct({ sessionId: Schema.String }))(
        await submitted.json(),
      );

      const open = () => app.send(`/api/sessions/${sessionId}/events`, undefined, cookie);

      streams.push(...(await Promise.all(Array.from({ length: 32 }, open))));
      expect(streams.every((response) => response.status === 200)).toBe(true);
      expect((await open()).status).toBe(429);
      await streams.pop()?.body?.cancel();
      const reopened = await open();
      streams.push(reopened);
      expect(reopened.status).toBe(200);
    } finally {
      await Promise.all(streams.map((response) => response.body?.cancel()));
      await app.runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("conversation deep links load the production scripts and styles", async () => {
    const assets = await loadWebAssets(
      fileURLToPath(new URL("../../../../web/dist/", import.meta.url)),
    );

    const directory = await mkdtemp(join(tmpdir(), "poppet-web-assets-"));
    const app = await fixture(directory, assets);

    try {
      const page = await app.send("/chat/example");
      const html = await page.text();

      const paths = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(
        (match) => match[1]!,
      );

      expect(paths.some((path) => path.endsWith(".js"))).toBe(true);
      expect(paths.some((path) => path.endsWith(".css"))).toBe(true);

      const lazyPaths = await Promise.all(
        paths.map(async (path) => {
          const url = new URL(path, `${settings.origin}/chat/example`);
          const response = await app.send(url.pathname);
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toContain(
            path.endsWith(".js") ? "javascript" : "css",
          );

          // Scripts load the Markdown renderer as a separate chunk with import().
          return [...(await response.text()).matchAll(/import\("(\/[^"]+\.js)"\)/g)].map(
            (match) => match[1]!,
          );
        }),
      );

      expect(lazyPaths.flat()).toHaveLength(1);

      for (const path of lazyPaths.flat()) {
        const response = await app.send(path);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("javascript");
      }

      expect([...assets.keys()].toSorted()).toEqual(
        ["/index.html", ...paths, ...lazyPaths.flat()].toSorted(),
      );
      expect([...assets.values()].map((asset) => [...asset.encoded.keys()].toSorted())).toEqual(
        [...assets.keys()].map(() => ["br", "gzip"]),
      );
    } finally {
      await app.runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serves the compressed copy a browser accepts and caches only hashed files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-web-encoding-"));
    const dist = await mkdtemp(join(tmpdir(), "poppet-web-dist-"));

    await Promise.all(
      Object.entries({
        "index.html": "<h1>Poppet</h1>",
        "index.html.br": "page-br",
        "index-abcd1234.js": "console.log('poppet');",
        "index-abcd1234.js.br": "script-br",
        "index-abcd1234.js.gz": "script-gz",
      }).map(([name, text]) => writeFile(join(dist, name), text)),
    );

    const app = await fixture(directory, await loadWebAssets(dist));

    const get = async (path: string, acceptEncoding?: string) => {
      const response = await app.handler(
        new Request(`${settings.origin}${path}`, {
          headers: {
            host: new URL(settings.origin).host,
            ...(acceptEncoding !== undefined && { "accept-encoding": acceptEncoding }),
          },
        }),
      );

      return {
        status: response.status,
        body: await response.text(),
        encoding: response.headers.get("content-encoding"),
        cache: response.headers.get("cache-control"),
        vary: response.headers.get("vary"),
      };
    };

    try {
      expect(await get("/index-abcd1234.js", "gzip, deflate, br, zstd")).toEqual({
        status: 200,
        body: "script-br",
        encoding: "br",
        cache: "public, max-age=31536000, immutable",
        vary: "accept-encoding",
      });
      expect(await get("/index-abcd1234.js", "br;q=0, gzip")).toMatchObject({
        body: "script-gz",
        encoding: "gzip",
      });
      expect(await get("/index-abcd1234.js")).toMatchObject({
        body: "console.log('poppet');",
        encoding: null,
      });
      expect(await get("/chat/example", "gzip")).toMatchObject({
        body: "<h1>Poppet</h1>",
        encoding: null,
        cache: "no-store",
      });
      expect(await get("/chat/example", "br")).toMatchObject({
        body: "page-br",
        encoding: "br",
        cache: "no-store",
      });
      expect((await get("/index-abcd1234.js.br")).status).toBe(404);
      expect((await get("/api/sessions")).cache).toBe("no-store");
    } finally {
      await app.runtime.dispose();
      await rm(directory, { recursive: true, force: true });
      await rm(dist, { recursive: true, force: true });
    }
  });

  test("protects API operations, validates origins and bodies, and revokes signed-in sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-web-"));
    const app = await fixture(directory);

    try {
      expect((await app.send("/api/sessions")).status).toBe(401);
      expect(
        (await app.send("/api/login", { key: accessKey }, "", "https://evil.example")).status,
      ).toBe(403);
      expect((await app.send("/api/login", { key: "wrong".repeat(10) })).status).toBe(401);
      const login = await app.send("/api/login", { key: accessKey });
      expect(login.headers.get("set-cookie")).toContain(
        "HttpOnly; SameSite=Strict; Path=/; Max-Age=43200; Secure",
      );
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      expect((await app.send("/api/sessions", undefined, cookie)).status).toBe(200);
      expect(
        (
          await app.send(
            "/api/submissions",
            { id: randomUUID(), sessionId: null, text: " " },
            cookie,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await app.send(
            "/api/submissions",
            { id: randomUUID(), sessionId: null, text: "hi", command: "shell" },
            cookie,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await app.send(
            "/api/submissions",
            { id: randomUUID(), sessionId: null, text: "x".repeat(300_000) },
            cookie,
          )
        ).status,
      ).toBe(413);
      expect((await app.send("/v1/commands", { kind: "store" }, cookie)).status).toBe(404);
      const page = await app.send("/chat/example");
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      await app.send("/api/logout", {}, cookie);
      expect((await app.send("/api/sessions", undefined, cookie)).status).toBe(401);
      expect(app.state.calls).toBe(0);
    } finally {
      await app.runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("deduplicates concurrent sends and continues through disconnect, reconnect and restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-web-"));
    const app = await fixture(directory);
    const submission = { id: randomUUID(), sessionId: null, text: "Hello there" };
    let sessionId = "";

    try {
      const cookie = await app.login();

      const [first, duplicate] = await Promise.all([
        app.send("/api/submissions", submission, cookie),
        app.send("/api/submissions", submission, cookie),
      ]);

      expect(first.status).toBe(202);
      const receipt = await first.json();
      expect(await duplicate.json()).toEqual(receipt);
      sessionId = receipt.sessionId;
      await app.runtime.runPromise(Deferred.await(app.entered));
      const firstStream = await app.send(`/api/sessions/${sessionId}/events`, undefined, cookie);
      const reader = firstStream.body!.getReader();
      const chunk = await reader.read();
      expect(new TextDecoder().decode(chunk.value)).toContain("Hello");
      await reader.cancel();
      expect((await app.runtime.runPromise(app.chat.snapshot(sessionId))).active?.id).toBe(
        submission.id,
      );
      expect(
        (await app.send("/api/submissions", { ...submission, text: "different" }, cookie)).status,
      ).toBe(409);
      expect(
        (
          await app.send(
            "/api/submissions",
            { id: randomUUID(), sessionId, text: "second" },
            cookie,
          )
        ).status,
      ).toBe(409);
      const anotherCookie = await app.login();

      const reconnected = await app.send(
        `/api/sessions/${sessionId}/events`,
        undefined,
        anotherCookie,
      );

      const anotherReader = reconnected.body!.getReader();
      expect(new TextDecoder().decode((await anotherReader.read()).value)).toContain(submission.id);
      await anotherReader.cancel();
      await app.runtime.runPromise(Deferred.succeed(app.release, undefined));
      expect((await app.settled(submission.id))?.status).toBe("completed");
      const snapshot = await app.runtime.runPromise(app.chat.snapshot(sessionId));
      expect(snapshot.messages.map((message) => message.text)).toEqual([
        "Hello there",
        "Hello world",
      ]);
      expect(snapshot.active).toBeNull();
      expect(JSON.stringify(snapshot)).not.toContain("provider-only-continuation");
      expect(app.state.calls).toBe(1);
      await app.runtime.runPromise(
        SqlClient.SqlClient.use(
          (sql) =>
            sql`UPDATE web_chat_submissions SET status = 'accepted' WHERE id = ${submission.id}`,
        ),
      );
    } finally {
      await app.runtime.dispose();
    }

    const restarted = await fixture(directory);

    try {
      expect(
        (await restarted.runtime.runPromise(restarted.chat.submit(submission))).sessionId,
      ).toBe(sessionId);
      expect(restarted.state.calls).toBe(0);
      expect(
        (await restarted.runtime.runPromise(restarted.chat.receipt(submission.id)))?.status,
      ).toBe("completed");
      expect(
        (await restarted.runtime.runPromise(restarted.chat.snapshot(sessionId))).messages,
      ).toHaveLength(2);
    } finally {
      await restarted.runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps the live reply visible across tool requests and omits empty saved replies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-web-"));
    const app = await fixture(directory);
    const submission = { id: randomUUID(), sessionId: null, text: "Find the results" };

    try {
      const receipt = await app.runtime.runPromise(app.chat.submit(submission));
      await app.runtime.runPromise(Deferred.await(app.entered));
      const store = await app.runtime.runPromise(Store);

      await app.runtime.runPromise(
        Effect.gen(function* () {
          for (const callId of ["search", "fetch"]) {
            const call = {
              type: "tool-call" as const,
              callId,
              name: callId,
              namespace: "web",
              arguments: "{}",
            };

            yield* store.recordToolCalls(submission.id, {
              output:
                callId === "search"
                  ? [call]
                  : [{ type: "text", text: "Checking the source." }, call],
              continuation: {
                version: 1,
                provider: "test-provider",
                model: "test-model",
                data: {},
              },
              finishReason: "tool-calls",
              usage: null,
            });
            yield* store.startToolCall(submission.id, callId);
            yield* store.finishToolCall(submission.id, callId, {
              status: "completed",
              output: "Results",
            });
          }
        }),
      );

      const during = await app.runtime.runPromise(app.chat.snapshot(receipt.sessionId));
      expect(during.messages.map((message) => message.role)).toEqual(["user"]);
      expect(during.active?.text).toBe("Hello");
      await app.runtime.runPromise(Deferred.succeed(app.release, undefined));
      expect((await app.settled(submission.id))?.status).toBe("completed");
      const completed = await app.runtime.runPromise(app.chat.snapshot(receipt.sessionId));
      expect(completed.active).toBeNull();
      expect(completed.messages.map((message) => message.text)).toEqual([
        "Find the results",
        "Checking the source.",
        "Hello world",
      ]);
    } finally {
      await app.runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["stop", "failure", "shutdown"] as const)(
    "settles %s without saving partial output or replaying the request",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-web-"));
      const app = await fixture(directory);
      const submission = { id: randomUUID(), sessionId: null, text: "Please answer" };
      const receipt = await app.runtime.runPromise(app.chat.submit(submission));
      await app.runtime.runPromise(Deferred.await(app.entered));

      try {
        if (mode === "failure") {
          app.state.fail = true;
          await app.runtime.runPromise(Deferred.succeed(app.release, undefined));
        } else if (mode === "stop") {
          const cookie = await app.login();
          expect(
            (await app.send(`/api/sessions/${receipt.sessionId}/stop`, {}, cookie)).status,
          ).toBe(200);
        }

        if (mode !== "shutdown") {
          expect((await app.settled(submission.id))?.status).toBe(
            mode === "failure" ? "failed" : "interrupted",
          );
        }
      } finally {
        await app.runtime.dispose();
      }

      const restarted = await fixture(directory);

      try {
        const saved = await restarted.runtime.runPromise(restarted.chat.submit(submission));
        expect(saved.status).toBe(mode === "failure" ? "failed" : "interrupted");
        expect(restarted.state.calls).toBe(0);

        const snapshot = await restarted.runtime.runPromise(
          restarted.chat.snapshot(receipt.sessionId),
        );

        expect(snapshot.messages.map((message) => message.role)).toEqual(["user"]);
        const store = await restarted.runtime.runPromise(Store);
        expect((await restarted.runtime.runPromise(store.runs(receipt.sessionId)))[0]?.status).toBe(
          mode === "failure" ? "failed" : "interrupted",
        );
      } finally {
        await restarted.runtime.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("when a conversation is deleted, refuses it during a reply and removes it with its receipts after", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-web-"));
    const app = await fixture(directory);

    const remove = (id: string, cookie: string, origin = settings.origin) =>
      app.handler(
        new Request(`${settings.origin}/api/sessions/${id}`, {
          method: "DELETE",
          headers: { host: new URL(settings.origin).host, origin, cookie },
        }),
      );

    try {
      const cookie = await app.login();
      const submission = { id: randomUUID(), sessionId: null, text: "Please answer" };
      const receipt = await app.runtime.runPromise(app.chat.submit(submission));
      await app.runtime.runPromise(Deferred.await(app.entered));
      expect((await remove(receipt.sessionId, cookie)).status).toBe(409);

      await app.runtime.runPromise(Deferred.succeed(app.release, undefined));
      expect((await app.settled(submission.id))?.status).toBe("completed");
      expect((await remove(receipt.sessionId, "")).status).toBe(401);
      expect((await remove(receipt.sessionId, cookie, "https://other.test")).status).toBe(403);
      expect((await remove(receipt.sessionId, cookie)).status).toBe(200);

      expect((await app.send(`/api/sessions/${receipt.sessionId}`, undefined, cookie)).status).toBe(
        404,
      );
      expect((await app.send(`/api/submissions/${submission.id}`, undefined, cookie)).status).toBe(
        404,
      );
      expect(await (await app.send("/api/sessions", undefined, cookie)).json()).toEqual([]);
      expect((await remove(receipt.sessionId, cookie)).status).toBe(404);
    } finally {
      await app.runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serves the same protected API through a TCP listener behind a preserved public Host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-web-"));
    const app = await fixture(directory);

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => app.handler(request),
    });

    try {
      expect((await fetch(server.url)).status).toBe(403);

      const headers = {
        host: "chat.example.test",
        origin: settings.origin,
        "content-type": "application/json",
      };

      const page = await fetch(server.url, { headers });
      expect(await page.text()).toBe("<h1>Poppet</h1>");

      const login = await fetch(new URL("/api/login", server.url), {
        method: "POST",
        headers,
        body: JSON.stringify({ key: accessKey }),
      });

      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

      const sessions = await fetch(new URL("/api/sessions", server.url), {
        headers: { ...headers, cookie },
      });

      expect(await sessions.json()).toEqual([]);
    } finally {
      await server.stop(true);
      await app.runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("permits HTTP only for loopback development origins and restricts listener hostname to loopback", () => {
    const valid = Schema.is(WebSettings);
    expect(valid({ ...settings, origin: "http://127.0.0.1:8080" })).toBe(true);
    expect(valid({ ...settings, origin: "http://192.168.1.20:8080" })).toBe(false);
    expect(valid({ ...settings, origin: "https://chat.example.test/path" })).toBe(false);
    expect(valid({ ...settings, hostname: "localhost" })).toBe(true);
    expect(valid({ ...settings, hostname: "::1" })).toBe(true);
    expect(valid({ ...settings, hostname: "0.0.0.0" })).toBe(false);
    expect(valid({ ...settings, hostname: "192.168.1.10" })).toBe(false);
  });

  test("when Host is missing or mismatched, rejects with 403 and accepts case-insensitive matches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-web-host-"));
    const app = await fixture(directory);

    try {
      expect((await app.handler(new Request(`${settings.origin}/`))).status).toBe(403);
      expect(
        (
          await app.handler(
            new Request(`${settings.origin}/`, {
              headers: { host: "CHAT.EXAMPLE.TEST" },
            }),
          )
        ).status,
      ).toBe(200);
    } finally {
      await app.runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when a session is renamed without changing updated_at, changes its SSE marker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-web-rename-"));
    const app = await fixture(directory);

    try {
      const store = await app.runtime.runPromise(Store);

      const session = await app.runtime.runPromise(
        store.createSession("test-provider", "test-model"),
      );

      const before = await app.runtime.runPromise(app.chat.marker(session.id));
      await app.runtime.runPromise(store.renameSession(session.id, "Renamed conversation"));
      const after = await app.runtime.runPromise(app.chat.marker(session.id));

      expect(after).not.toBe(before);
    } finally {
      await app.runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
