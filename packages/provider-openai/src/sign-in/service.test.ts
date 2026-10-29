import { describe, expect, test } from "bun:test";

import { Console, Effect, Fiber, Queue } from "effect";

import { ConnectionError } from "#src/connection";
import { makeBrowserSignIn, type SignInRequest } from "#src/sign-in/service";

const request: SignInRequest = {
  endpoint: "https://auth.openai.com/api/accounts/authorize",
  applicationName: "Poppet",
  hostId: "urn:uuid:555df4e7-6763-4d11-bb27-2c56e759e319",
  clientId: null,
  consent: false,
  noBrowser: false,
  callbackPort: null,
  paste: Effect.never,
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

// Starts a sign-in that prints its link instead of opening a browser, with a
// queue standing in for lines pasted into the terminal.
const startPasteSignIn = async (selected: Partial<SignInRequest> = {}) => {
  const printed = Promise.withResolvers<string>();
  const errors: string[] = [];
  const lines = Effect.runSync(Queue.unbounded<string>());

  const recording: Console.Console = {
    ...quietConsole,
    log: (text: string) => {
      const link = text.split("\n").find((line) => line.startsWith("https://"));

      if (link) printed.resolve(link);
    },
    error: (text: string) => {
      errors.push(text);
    },
  };

  const opened: string[] = [];

  const browser = makeBrowserSignIn((url) => Effect.sync(() => opened.push(url)));

  const result = Effect.runPromise(
    browser.authorize({ ...request, noBrowser: true, paste: Queue.take(lines), ...selected }).pipe(
      Effect.provideService(Console.Console, recording),
      Effect.match({
        onSuccess: (authorization) => authorization.clientId,
        onFailure: (error) => error.reason,
      }),
    ),
  );

  const callback = callbackFor(await printed.promise);

  return {
    callback,
    errors,
    opened,
    result,
    paste: (line: string) => Effect.runSync(Queue.offer(lines, line)),
  };
};

const browserError = () =>
  new ConnectionError({ reason: "callback", message: "Test browser failed." });

describe("makeBrowserSignIn", () => {
  test.each(["accepted", "declined"])(
    "when authorization is %s, delivers its callback page before shutdown",
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

  test("when callbacks use a foreign host or repeat, rejects them and consumes the valid callback once", async () => {
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

  test("when callback state mismatches, ignores it so the valid callback can complete", async () => {
    const statuses: number[] = [];

    const browser = makeBrowserSignIn((url) =>
      Effect.tryPromise({
        try: async (signal) => {
          const callback = callbackFor(url);
          const forged = new URL(callback);
          forged.searchParams.set("state", "forged");
          statuses.push((await fetch(forged, { signal })).status);
          forged.searchParams.delete("state");
          statuses.push((await fetch(forged, { signal })).status);
          statuses.push((await fetch(callback, { signal })).status);
        },
        catch: browserError,
      }),
    );

    const result = await Effect.runPromise(
      browser.authorize(request).pipe(Effect.provideService(Console.Console, quietConsole)),
    );

    expect(result.clientId).toBe("oaiapp_test");
    expect(statuses).toEqual([400, 400, 200]);
  });

  test.each(["missing", "placeholder", "changed", "duplicate"] as const)(
    "when callback registration is %s, rejects it",
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

  test("when the sign-in deadline expires, closes the listener", async () => {
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

  test("when sign-in is interrupted, closes the listener", async () => {
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

  test("without a browser, ignores mismatched pasted addresses until the callback address completes sign-in", async () => {
    const signIn = await startPasteSignIn();
    const forged = new URL(signIn.callback);
    forged.searchParams.set("state", "forged");
    const foreign = new URL(signIn.callback);
    foreign.port = "1";

    for (const line of ["", "not a url", forged.toString(), foreign.toString()]) signIn.paste(line);
    signIn.paste(`  ${signIn.callback.toString()}  `);

    expect(await signIn.result).toBe("oaiapp_test");
    expect(signIn.opened).toEqual([]);
    expect(signIn.errors).toHaveLength(3);
    await expect(fetch(signIn.callback)).rejects.toThrow();
  });

  test("without a browser, a pasted declined address ends sign-in", async () => {
    const signIn = await startPasteSignIn();
    signIn.callback.searchParams.set("error", "access_denied");
    signIn.paste(signIn.callback.toString());

    expect(await signIn.result).toBe("denied");
  });

  test("with a fixed callback port, a forwarded browser callback completes sign-in without a paste", async () => {
    // Reserve a free port, then release it for the sign-in listener.
    const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = Number(reserved.url.port);
    await reserved.stop(true);

    const signIn = await startPasteSignIn({ callbackPort: port });
    expect(signIn.callback.origin).toBe(`http://127.0.0.1:${port}`);

    expect((await fetch(signIn.callback)).status).toBe(200);
    expect(await signIn.result).toBe("oaiapp_test");
  });

  test("when the fixed callback port is taken, fails before printing a link", async () => {
    const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });

    try {
      const browser = makeBrowserSignIn(() => Effect.void);

      await expect(
        Effect.runPromise(
          browser
            .authorize({ ...request, callbackPort: Number(taken.url.port) })
            .pipe(Effect.provideService(Console.Console, quietConsole)),
        ),
      ).rejects.toMatchObject({ reason: "callback" });
    } finally {
      await taken.stop(true);
    }
  });
});
