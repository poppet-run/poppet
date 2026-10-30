import { Console, Effect } from "effect";

import type { Callback } from "#src/callback";
import { SignInError } from "#src/errors";

export interface BrowserOptions<E> {
  /** Names the service in the printed instructions. */
  readonly service: string;
  /** Skips the system browser and accepts a callback URL pasted into the terminal. */
  readonly noBrowser: boolean;
  /** True when the system browser would open on another machine or nowhere. */
  readonly remote: boolean;
  /** Reads one pasted line when the browser cannot reach the listener. */
  readonly paste: Effect.Effect<string, E>;
  /** Failures fall back to the printed link. */
  readonly open: (url: string) => Effect.Effect<void, unknown>;
  readonly timeoutMs: number;
}

/**
 * Sends the owner to an authorization URL and waits for its callback, from the listener or
 * pasted into the terminal, until the deadline.
 */
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

    // Keep reading until a pasted URL completes the attempt. A forwarded
    // browser callback can still finish first and interrupts the prompt.
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
