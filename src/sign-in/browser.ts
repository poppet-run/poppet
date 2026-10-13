import { Effect } from "effect";

import { ConnectionError } from "../connection.ts";

const browserError = () =>
  new ConnectionError({ reason: "callback", message: "Could not open the system browser." });

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
