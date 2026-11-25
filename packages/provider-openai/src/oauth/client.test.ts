import { describe, expect, test } from "bun:test";

import { Effect, Fiber, Match, Redacted } from "effect";
import { TestClock } from "effect/testing";

import { makeOAuthClient } from "#src/oauth/client";
import { request as httpRequest } from "#src/oauth/http";
import type { HttpFetch } from "#src/oauth/http";

describe("client.ts", () => {
  test("when discovery fails temporarily, retries and caches the successful response", async () => {
    const issuer = "https://oauth.invalid";
    let requests = 0;

    const http: HttpFetch = async () => {
      if (++requests === 1) {
        return new Response(null, { status: 503 });
      }

      return Response.json({
        issuer,
        authorization_endpoint: issuer + "/authorize",
        token_endpoint: issuer + "/token",
        revocation_endpoint: issuer + "/revoke",
        jwks_uri: issuer + "/keys",
      });
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeOAuthClient(http, issuer);
        expect(yield* Effect.flip(client.authorizationEndpoint)).toMatchObject({
          reason: "temporary",
        });
        expect(yield* client.authorizationEndpoint).toBe(issuer + "/authorize");
        expect(yield* client.authorizationEndpoint).toBe(issuer + "/authorize");
        expect(requests).toBe(2);
      }),
    );
  });

  test("when response headers stall until the request deadline, aborts the request", async () => {
    const started = Promise.withResolvers<void>();
    let aborted = false;

    const http: HttpFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;

        if (!signal) {
          throw new Error("Missing request cancellation");
        }

        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("Aborted"));
          },
          { once: true },
        );
        started.resolve();
      });

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* httpRequest(http, "https://oauth.invalid").pipe(
            Effect.result,
            Effect.forkChild,
          );

          yield* Effect.promise(() => started.promise);
          yield* TestClock.adjust("20 seconds");

          return yield* Fiber.join(fiber);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );

    expect(result).toMatchObject({
      failure: {
        reason: "temporary",
        message: "Could not contact OpenAI. Retry later; existing credentials were retained.",
      },
    });
    expect(aborted).toBe(true);
  });

  test.each(["discovery", "token", "token-error", "revoke", "stalled revoke"])(
    "when a %s response times out or completes, closes its body",
    async (operation) => {
      const reading = Promise.withResolvers<void>();
      const cancelled = Promise.withResolvers<void>();
      const signals: Array<AbortSignal> = [];
      const issuer = "https://oauth.invalid";

      const discovery = {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        revocation_endpoint: `${issuer}/revoke`,
        jwks_uri: `${issuer}/keys`,
      };

      const http: HttpFetch = async (input, init) => {
        const url = input.toString();

        if (operation !== "discovery" && url.endsWith("openid-configuration")) {
          return Response.json(discovery);
        }

        const signal = init?.signal;

        if (!signal) {
          throw new Error("Missing request cancellation");
        }

        signals.push(signal);

        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener("abort", () => controller.error(new Error("Aborted")), {
                once: true,
              });
            },
            pull() {
              reading.resolve();
            },
            cancel() {
              cancelled.resolve();

              if (operation === "stalled revoke") {
                return new Promise<void>(() => {});
              }
            },
          }),
          { status: operation === "token-error" ? 400 : 200 },
        );
      };

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* makeOAuthClient(http, issuer);

          const request = Match.value(operation).pipe(
            Match.when("discovery", () => client.authorizationEndpoint.pipe(Effect.asVoid)),
            Match.when(Match.is("revoke", "stalled revoke"), () =>
              client.revoke(Redacted.make("test-refresh"), "test-client").pipe(Effect.asVoid),
            ),
            Match.orElse(() => client.exchange(new URLSearchParams()).pipe(Effect.asVoid)),
          );

          const fiber = yield* request.pipe(Effect.result, Effect.forkChild);

          if (operation.endsWith("revoke")) {
            yield* Effect.promise(() => cancelled.promise);

            if (operation === "stalled revoke") {
              yield* TestClock.adjust("20 seconds");
            }
          } else {
            yield* Effect.promise(() => reading.promise);
            yield* TestClock.adjust("20 seconds");
          }

          return yield* Fiber.join(fiber);
        }).pipe(Effect.provide(TestClock.layer())),
      );

      if (operation === "revoke") {
        expect(result).toHaveProperty("success");
      } else {
        expect(result).toHaveProperty("failure.reason", "temporary");
      }

      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
    },
  );

  test.each([
    ["discovery", "drops", "temporary"],
    ["discovery", "is malformed", "identity"],
    ["token", "drops", "temporary"],
    ["token", "is malformed", "identity"],
  ] as const)("when a %s body %s, reports the %s reason", async (operation, mode, reason) => {
    const issuer = "https://oauth.invalid";

    const body = () =>
      mode === "drops"
        ? new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
              controller.error(new Error("Connection reset"));
            },
          })
        : "{";

    const http: HttpFetch = async (input) =>
      operation === "token" && input.toString().endsWith("openid-configuration")
        ? Response.json({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            revocation_endpoint: `${issuer}/revoke`,
            jwks_uri: `${issuer}/keys`,
          })
        : new Response(body());

    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeOAuthClient(http, issuer);

        return yield* Effect.flip(
          operation === "discovery"
            ? client.authorizationEndpoint.pipe(Effect.asVoid)
            : client.exchange(new URLSearchParams()).pipe(Effect.asVoid),
        );
      }),
    );

    expect(failure.reason).toBe(reason);
  });
});
