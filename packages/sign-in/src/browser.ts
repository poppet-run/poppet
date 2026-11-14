import { Effect } from "effect";

import { SignInError } from "#src/errors";

const browserError = () =>
  new SignInError({ reason: "callback", message: "Could not open the system browser." });

export const openBrowser = (url: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const command = process.platform === "darwin" ? ["open", url] : ["xdg-open", url];

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
