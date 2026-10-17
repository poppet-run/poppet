import { describe, expect, test } from "bun:test";

import { ChatSettings, WebSearch, defaultPolicy } from "@poppet/agent";
import { ApiKeyStore } from "@poppet/credentials";
import { ConfigProvider, Effect, Fiber, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";

import { makeWebSearch, WebSearchLive } from "#src/web-search";

const http = (
  run: (input: string | URL | Request, init?: BunFetchRequestInit) => Promise<Response>,
): typeof fetch => Object.assign(run, { preconnect: () => {} });

const search = (httpFetch: typeof fetch) =>
  makeWebSearch(Redacted.make("test-search-key"), 1024, httpFetch).search!("current topic");

describe("Brave Search transport", () => {
  test.each([
    [false, true],
    [true, false],
    [true, true],
  ])(
    "advertises search only when enabled with a key, enabled: %s stored: %s",
    async (enabled, stored) => {
      let reads = 0;

      const layer = WebSearchLive.pipe(
        Layer.provide([
          Layer.succeed(ChatSettings, defaultPolicy),
          Layer.succeed(ApiKeyStore, {
            read: () =>
              Effect.sync(() => {
                reads++;

                return stored ? Redacted.make("test-key") : null;
              }),
            write: () => Effect.void,
            remove: () => Effect.void,
          }),
        ]),
      );

      const service = await Effect.runPromise(
        WebSearch.pipe(
          Effect.provide(layer),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: { POPPET_WEB_SEARCH: String(enabled) } }),
          ),
        ),
      );

      expect(service.search !== null).toBe(enabled && stored);
      expect(reads).toBe(enabled ? 1 : 0);
    },
  );

  test("sends only the query and fixed options to Brave and keeps its key out of results", async () => {
    const result = await Effect.runPromise(
      search(
        http(async (input, init) => {
          const url = new URL(input.toString());
          expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
          expect(Object.fromEntries(url.searchParams)).toEqual({
            q: "current topic",
            count: "5",
            result_filter: "web",
            text_decorations: "false",
          });
          expect(init?.redirect).toBe("error");
          expect(init?.headers).toEqual({
            Accept: "application/json",
            "X-Subscription-Token": "test-search-key",
          });

          return Response.json({
            type: "search",
            web: {
              results: [{ title: "Source", url: "https://example.com/", description: "Snippet" }],
            },
          });
        }),
      ),
    );

    expect(result).toEqual({
      results: [{ title: "Source", url: "https://example.com/", snippet: "Snippet" }],
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain("test-search-key");
  });

  test.each([
    [401, "tool-authentication"],
    [403, "tool-authentication"],
    [429, "tool-rate-limit"],
    [500, "tool-network"],
    [302, "tool-network"],
  ] as const)("reports HTTP %s without exposing the body or retrying", async (status, reason) => {
    let calls = 0;

    const error = await Effect.runPromise(
      search(
        http(async () => {
          calls++;

          return new Response("test-search-key private server details", { status });
        }),
      ).pipe(Effect.flip),
    );

    expect(error).toMatchObject({ reason, message: `Brave Search returned HTTP ${status}.` });
    expect(JSON.stringify(error)).not.toContain("test-search-key");
    expect(calls).toBe(1);
  });

  test.each([
    () => new Response("not json", { headers: { "Content-Type": "application/json" } }),
    () => Response.json({}),
    () =>
      Response.json({
        type: "search",
        web: { results: [{ title: 1, url: "https://example.com/" }] },
      }),
    () => new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "application/json" } }),
    () => new Response("<html>error</html>", { headers: { "Content-Type": "text/html" } }),
  ])("rejects malformed or unsupported responses", async (response) => {
    await expect(Effect.runPromise(search(http(async () => response())))).rejects.toMatchObject({
      reason: "tool-network",
    });
  });

  test("stops and cancels an oversized response stream", async () => {
    let cancelled = false;

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(600000));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      Effect.runPromise(
        search(
          http(async () => new Response(body, { headers: { "Content-Type": "application/json" } })),
        ),
      ),
    ).rejects.toMatchObject({ reason: "tool-limit" });
    expect(cancelled).toBe(true);
  });

  test.each([false, true])(
    "aborts the request on cancellation or deadline, timeout: %s",
    async (timeout) => {
      let aborted = false;

      const request = search(
        http(
          (_input, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(new Error("aborted"));
                },
                { once: true },
              );
            }),
        ),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* request.pipe(Effect.forkChild);
          yield* Effect.yieldNow;

          if (timeout) {
            yield* TestClock.adjust("15 seconds");
            expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toMatchObject({
              reason: "tool-network",
              message: expect.stringContaining("deadline"),
            });
          } else yield* Fiber.interrupt(fiber);
          expect(aborted).toBe(true);
        }).pipe(Effect.provide(TestClock.layer())),
      );
    },
  );
});
