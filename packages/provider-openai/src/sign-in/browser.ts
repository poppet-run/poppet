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
