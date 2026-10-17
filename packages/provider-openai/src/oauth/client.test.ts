import { expect, test } from "bun:test";

import { Effect, Fiber, Match, Redacted } from "effect";
import { TestClock } from "effect/testing";

import { makeOAuthClient } from "#src/oauth/client";
import type { HttpFetch } from "#src/oauth/http";

test.each(["discovery", "token", "token-error", "revoke"])(
  "closes the %s response body on timeout or completion",
  async (operation) => {
    const reading = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
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

      if (operation !== "discovery" && url.endsWith("openid-configuration"))
        return Response.json(discovery);

      const signal = init?.signal;

      if (!signal) throw new Error("Missing request cancellation");
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
        }),
        { status: operation === "token-error" ? 400 : 200 },
      );
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeOAuthClient(http, issuer);

        const request = Match.value(operation).pipe(
          Match.when("discovery", () => client.authorizationEndpoint.pipe(Effect.asVoid)),
          Match.when("revoke", () =>
            client.revoke(Redacted.make("test-refresh"), "test-client").pipe(Effect.asVoid),
          ),
          Match.orElse(() => client.exchange(new URLSearchParams()).pipe(Effect.asVoid)),
        );

        const fiber = yield* request.pipe(Effect.result, Effect.forkChild);

        if (operation !== "revoke") {
          yield* Effect.promise(() => reading.promise);
          yield* TestClock.adjust("20 seconds");
        }

        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    if (operation === "revoke") expect(result).toHaveProperty("success");
    else expect(result).toHaveProperty("failure.reason", "temporary");
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  },
);
