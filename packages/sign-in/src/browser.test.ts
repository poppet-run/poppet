import { describe, expect, test } from "bun:test";

import { Console, Effect } from "effect";

import { authorizeInBrowser } from "#src/authorize";
import { openBrowser, remoteSession } from "#src/browser";
import { startCallback } from "#src/callback";

const quiet = Effect.provideService(Console.Console, {
  ...console,
  log: () => {},
  error: () => {},
});

describe("remoteSession", () => {
  test.each([
    [{ SSH_CONNECTION: "10.0.0.2 50000 10.0.0.1 22" }, "darwin", true],
    [{}, "darwin", false],
    [{}, "linux", true],
    [{ DISPLAY: ":0" }, "linux", false],
    [{ WAYLAND_DISPLAY: "wayland-0" }, "linux", false],
  ])("for %o on %s, reports %p", (environment, platform, expected) => {
    expect(remoteSession(environment, platform)).toBe(expected);
  });
});

describe("openBrowser", () => {
  test.each(["file:///etc/passwd", "javascript:alert(1)", "-a Calculator", "not-a-url"])(
    "when the browser URL is %s, rejects it before launching a process",
    async (url) => {
      await expect(Effect.runPromise(openBrowser(url))).rejects.toMatchObject({
        reason: "callback",
      });
    },
  );
});

describe("authorizeInBrowser", () => {
  test("when launching the browser never exits, still completes as soon as the callback arrives", async () => {
    let openerInterrupted = false;

    const code = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const callback = yield* startCallback({
            port: null,
            service: "Test",
            received: "Done",
            accept: (received) => received,
          });

          return yield* authorizeInBrowser(callback, "https://auth.example/authorize", {
            service: "Test",
            noBrowser: false,
            remote: false,
            paste: Effect.never,
            timeoutMs: 2000,
            open: () =>
              Effect.gen(function* () {
                const target = new URL(callback.redirectUri);
                target.searchParams.set("code", "ok-code");
                target.searchParams.set("state", callback.state);
                yield* Effect.promise(() => fetch(target));
                yield* Effect.never;
              }).pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    openerInterrupted = true;
                  }),
                ),
              ),
          });
        }),
      ).pipe(quiet),
    );

    expect(code).toBe("ok-code");
    expect(openerInterrupted).toBe(true);
  });
});
