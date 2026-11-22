import { Effect } from "effect";

import { SignInError } from "#src/errors";

const browserError = () =>
  new SignInError({ reason: "callback", message: "Could not open the system browser." });

const validatedURL = (url: string) => {
  const parsed = new URL(url);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("Unsupported browser URL scheme.");

  return parsed.href;
};

export const openBrowser = (url: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Effect.try({
        try: () => validatedURL(url),
        catch: browserError,
      });

      const command = process.platform === "darwin" ? ["open", "--", target] : ["xdg-open", target];

      const browser = yield* Effect.acquireRelease(
        Effect.try({
          try: () => Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }),
          catch: browserError,
        }),
        (process) =>
          Effect.sync(() => {
            if (process.exitCode === null) process.kill();
          }),
      );

      const status = yield* Effect.tryPromise({ try: () => browser.exited, catch: browserError });

      if (status !== 0) return yield* Effect.fail(browserError());
    }),
  );

export const remoteSession = (environment: Record<string, string | undefined>, platform: string) =>
  Boolean(environment.SSH_CONNECTION || environment.SSH_TTY) ||
  (platform === "linux" && !environment.DISPLAY && !environment.WAYLAND_DISPLAY);
