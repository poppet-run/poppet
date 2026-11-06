import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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
import { LocalMemoryLive } from "@poppet/memory";
import { invalidRequest, type ModelOperations } from "@poppet/provider";
import { Store, StoreLive } from "@poppet/store";
import { Deferred, Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { SqlClient } from "effect/sql";

import { WebChat, WebChatLive } from "#src/commands/web-chat/chat";
import { webHandler, WebSettings } from "#src/commands/web-chat/server";

const accessKey = "test-only-web-chat-key-with-at-least-32-characters";

const settings: WebSettings = {
  origin: "https://chat.example.test",
  hostname: "127.0.0.1",
  port: 8080,
  accessKeyHash: createHash("sha256").update(accessKey).digest("hex"),
};

const fixture = async (
  directory: string,
  assets: ReadonlyMap<string, Blob> = new Map([
    ["/index.html", new Blob(["<h1>Poppet</h1>"], { type: "text/html" })],
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

  const config = Layer.succeed(AppConfig, {
    applicationName: "Test",
    dataDirectory: directory,
    provider: "test-provider",
    model: "test-model",
  });

  const store = StoreLive.pipe(Layer.provideMerge(config));

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
        headers: { origin, cookie, "content-type": "application/json" },
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

          if (receipt?.status !== "accepted") return receipt;
          yield* Effect.sleep("5 millis");
        }
      }).pipe(Effect.timeout("3 seconds")),
    );

  return { runtime, chat, state, send, handler, login, release, entered, settled };
};

describe("web chat", () => {
  test("conversation deep links load the production scripts and styles", async () => {
    const web = fileURLToPath(new URL("../../../../web/", import.meta.url));

    // bun run check builds these production artifacts before running tests.
    const assets = new Map<string, Blob>();

    for (const name of await readdir(join(web, "dist")))
      assets.set(`/${name}`, Bun.file(join(web, "dist", name)));
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

      await Promise.all(
        paths.map(async (path) => {
          const url = new URL(path, `${settings.origin}/chat/example`);
          const response = await app.send(url.pathname);
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toContain(
            path.endsWith(".js") ? "javascript" : "css",
          );
        }),
      );

      expect([...assets.keys()].toSorted()).toEqual(["/index.html", ...paths].toSorted());
    } finally {
      await app.runtime.dispose();
      await rm(directory, { recursive: true, force: true });
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
            { id: randomUUID(), sessionId: null, text: "x".repeat(300000) },
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
      // Simulate a crash after the answer committed but before the receipt settled.
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

      // Reproduce persisted tool exchanges while the provider's final reply is still streaming.
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

        if (mode !== "shutdown")
          expect((await app.settled(submission.id))?.status).toBe(
            mode === "failure" ? "failed" : "interrupted",
          );
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

  test("permits HTTP only for loopback development origins", () => {
    const valid = Schema.is(WebSettings);
    expect(valid({ ...settings, origin: "http://127.0.0.1:8080" })).toBe(true);
    expect(valid({ ...settings, origin: "http://192.168.1.20:8080" })).toBe(false);
    expect(valid({ ...settings, origin: "https://chat.example.test/path" })).toBe(false);
  });
});
