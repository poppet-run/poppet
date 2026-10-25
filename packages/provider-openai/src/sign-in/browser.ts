import { Effect } from "effect";

import { ConnectionError } from "#src/connection";

const browserError = () =>
  new ConnectionError({ reason: "callback", message: "Could not open the system browser." });

export const openBrowser = (url: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const command = process.platform === "darwin" ? ["open", url] : ["xdg-open", url];

      // Own the launcher subprocess until it exits. Cancellation kills a stuck
      // launcher so sign-in does not leave a child process running.
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

/**
 * Reports a session whose system browser is missing or belongs to another
 * machine, so sign-in prints its link and accepts a pasted callback instead.
 */
export const remoteSession = (environment: Record<string, string | undefined>, platform: string) =>
  Boolean(environment.SSH_CONNECTION || environment.SSH_TTY) ||
  (platform === "linux" && !environment.DISPLAY && !environment.WAYLAND_DISPLAY);
