import { describe, expect, test } from "bun:test";

import { Console, Effect, Fiber } from "effect";

import { ConnectionError } from "#src/connection";
import { makeBrowserSignIn, type SignInRequest } from "#src/sign-in/service";

const request: SignInRequest = {
  endpoint: "https://auth.openai.com/api/accounts/authorize",
  applicationName: "Poppet",
  hostId: "urn:uuid:555df4e7-6763-4d11-bb27-2c56e759e319",
  clientId: null,
  consent: false,
};

const quietConsole: Console.Console = { ...console, log: () => undefined, error: () => undefined };

const callbackFor = (authorizationUrl: string) => {
  const authorization = new URL(authorizationUrl);
  const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
  callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");
  callback.searchParams.set("code", "test-code");
  callback.searchParams.set("client_id", "oaiapp_test");

  return callback;
};

const browserError = () =>
  new ConnectionError({ reason: "callback", message: "Test browser failed." });

describe("Browser sign-in", () => {
  test.each(["accepted", "declined"])(
    "delivers the %s callback page before shutdown",
    async (outcome) => {
      const declined = outcome === "declined";
      const opened = Promise.withResolvers<URL>();

      const browser = makeBrowserSignIn((url) =>
        Effect.sync(() => {
          opened.resolve(callbackFor(url));
        }),
      );

      // The system browser returns before making the callback request. Keep the
      // response read outside the opener so shutdown can race with its delivery.
      const authorization = Effect.runPromise(
        browser
          .authorize(request)
          .pipe(
            Effect.provideService(Console.Console, quietConsole),
            Effect.match({ onSuccess: () => "authorized", onFailure: (error) => error.reason }),
          ),
      );

      const callback = await opened.promise;

      if (declined) callback.searchParams.set("error", "access_denied");

      const response = await fetch(callback);
      const body = await response.text();
      expect(response.status).toBe(declined ? 400 : 200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).toContain(
        declined ? "Sign-in could not be completed" : "Authorization received",
      );
      expect(await authorization).toBe(declined ? "denied" : "authorized");
      await expect(fetch(callback, { keepalive: false })).rejects.toThrow();
    },
  );

  test("rejects a foreign host and consumes a callback only once", async () => {
    const statuses: number[] = [];

    const browser = makeBrowserSignIn((url) =>
      Effect.tryPromise({
        try: async (signal) => {
          const callback = callbackFor(url);
          statuses.push(
            (await fetch(callback, { signal, headers: { Host: "foreign.invalid" } })).status,
          );
          const accepted = await fetch(callback, { signal });
          statuses.push(accepted.status);
          expect(accepted.headers.get("referrer-policy")).toBe("no-referrer");
          statuses.push((await fetch(callback, { signal })).status);
        },
        catch: browserError,
      }),
    );

    const result = await Effect.runPromise(
      browser.authorize(request).pipe(Effect.provideService(Console.Console, quietConsole)),
    );

    expect(result.clientId).toBe("oaiapp_test");
    expect(statuses).toEqual([400, 200, 410]);
  });

  test.each(["missing", "placeholder", "changed", "duplicate"] as const)(
    "rejects a %s callback registration",
    async (failure) => {
      const browser = makeBrowserSignIn((url) =>
        Effect.tryPromise({
          try: async (signal) => {
            const callback = callbackFor(url);

            if (failure === "missing") callback.searchParams.delete("client_id");

            if (failure === "placeholder")
              callback.searchParams.set("client_id", "dynamic_agent_client");

            if (failure === "changed") callback.searchParams.set("client_id", "oaiapp_another");

            if (failure === "duplicate") callback.searchParams.append("client_id", "oaiapp_test");
            await fetch(callback, { signal });
          },
          catch: browserError,
        }),
      );

      const selected = { ...request, clientId: failure === "changed" ? "oaiapp_test" : null };
      await expect(
        Effect.runPromise(
          browser.authorize(selected).pipe(Effect.provideService(Console.Console, quietConsole)),
        ),
      ).rejects.toMatchObject({ reason: "callback" });
    },
  );

  test("closes the listener when the sign-in deadline expires", async () => {
    const opened = Promise.withResolvers<string>();

    const browser = makeBrowserSignIn(
      (url) =>
        Effect.sync(() => {
          opened.resolve(callbackFor(url).toString());
        }),
      50,
    );

    const result = Effect.runPromise(
      browser.authorize(request).pipe(Effect.provideService(Console.Console, quietConsole)),
    );

    const callback = await opened.promise;
    await expect(result).rejects.toMatchObject({
      reason: "callback",
      message: "Sign-in timed out. Start a new sign-in.",
    });
    await expect(fetch(callback)).rejects.toThrow();
  });

  test("closes the listener when sign-in is interrupted", async () => {
    const opened = Promise.withResolvers<string>();

    const browser = makeBrowserSignIn((url) =>
      Effect.sync(() => {
        opened.resolve(callbackFor(url).toString());
      }),
    );

    const fiber = Effect.runFork(
      browser.authorize(request).pipe(Effect.provideService(Console.Console, quietConsole)),
    );

    const callback = await opened.promise;
    await Effect.runPromise(Fiber.interrupt(fiber));
    await expect(fetch(callback)).rejects.toThrow();
  });
});
