import { Console, Effect } from "effect";

import type { Callback } from "#src/callback";
import { SignInError } from "#src/errors";

export interface BrowserOptions<E> {
  readonly service: string;
  readonly noBrowser: boolean;
  readonly remote: boolean;
  readonly paste: Effect.Effect<string, E>;
  readonly open: (url: string) => Effect.Effect<void, unknown>;
  readonly timeoutMs: number;
}

export const authorizeInBrowser = <A, E>(
  callback: Callback<A>,
  url: string,
  options: BrowserOptions<E>,
) =>
  Effect.gen(function* () {
    if (!options.noBrowser && !options.remote) {
      yield* Console.log(
        `Continue with ${options.service}:\n${url}\nWaiting for the browser callback. Press Ctrl+C to cancel.`,
      );
      yield* options
        .open(url)
        .pipe(
          Effect.catch(() =>
            Console.error("Could not open the system browser. Open the sign-in link above."),
          ),
        );

      return yield* callback.authorization;
    }

    yield* Console.log(
      `Open this link in a browser on any device to continue with ${options.service}:\n${url}\n` +
        `If that browser then shows an error page for ${callback.redirectUri}, copy the full address from its address bar and paste it here.`,
    );

    const pasted = Effect.gen(function* () {
      while (true) {
        const line = yield* options.paste;

        if (line.trim() === "") continue;

        if (callback.submitPasted(line).completed) return;
        yield* Console.error(
          "That address does not match this sign-in. Paste the full address from the browser after signing in.",
        );
      }
    });

    return yield* Effect.raceFirst(
      callback.authorization,
      pasted.pipe(Effect.andThen(callback.authorization)),
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: options.timeoutMs,
      orElse: () =>
        Effect.fail(
          new SignInError({
            reason: "callback",
            message: "Sign-in timed out. Start a new sign-in.",
          }),
        ),
    }),
  );
