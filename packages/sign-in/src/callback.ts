import { randomBytes } from "node:crypto";

import { Deferred, Effect } from "effect";

import { SignInError } from "#src/errors";
import { callbackResponse } from "#src/page";

/** How a callback ended the attempt, or why it was ignored so a valid one can still arrive. */
export type CallbackOutcome =
  | { readonly completed: true; readonly accepted: boolean }
  | { readonly completed: false; readonly status: 400 | 404 | 410; readonly message: string };

export interface CallbackOptions<A> {
  /** A fixed listener port for SSH forwarding; null picks any free port. */
  readonly port: number | null;
  /** Names the service in the declined-sign-in message. */
  readonly service: string;
  /** Shown by the browser once the callback is accepted. */
  readonly received: string;
  /**
   * Completes the attempt from a callback that carries this attempt's state and exactly one
   * code. Null rejects it, for example when service-specific parameters are invalid.
   */
  readonly accept: (code: string, parameters: URLSearchParams, redirectUri: string) => A | null;
}

/** A loopback callback listener for one authorization attempt, owned by the caller's scope. */
export interface Callback<A> {
  readonly state: string;
  readonly redirectUri: string;
  /** Checks a callback URL copied from a browser that could not reach the listener. */
  readonly submitPasted: (pasted: string) => CallbackOutcome;
  readonly authorization: Effect.Effect<A, SignInError>;
}

export const startCallback = <A>(options: CallbackOptions<A>) =>
  Effect.gen(function* () {
    // State links the callback to this attempt.
    const state = randomBytes(32).toString("base64url");
    // The listener or a pasted callback URL completes this Deferred once,
    // allowing the sign-in Effect to wait for either without polling.
    const result = yield* Deferred.make<A, SignInError>();
    let consumed = false;

    // Both callback sources share these checks. The origin is the one the
    // callback must use: the listener's own address or the issued redirect URI.
    const submit = (callback: URL, origin: string): CallbackOutcome => {
      if (callback.pathname !== "/auth/callback")
        return { completed: false, status: 404, message: "Not found" };

      if (callback.origin !== origin)
        return { completed: false, status: 400, message: "Invalid callback host." };

      if (consumed)
        return { completed: false, status: 410, message: "Sign-in attempt already completed." };

      const reject = (message: string, reason: "callback" | "denied" = "callback") => {
        consumed = true;
        Deferred.doneUnsafe(result, Effect.fail(new SignInError({ reason, message })));

        return { completed: true, accepted: false } as const;
      };

      // Check state before accepting either a code or a reported sign-in error. A callback
      // without this attempt's state is ignored, so another local caller cannot end it.
      if (
        callback.searchParams.getAll("state").length !== 1 ||
        callback.searchParams.get("state") !== state
      )
        return { completed: false, status: 400, message: "Invalid sign-in state." };

      if (callback.searchParams.has("error"))
        return reject(
          `${options.service} sign-in was declined or could not be completed.`,
          "denied",
        );

      const code = callback.searchParams.get("code");

      const accepted =
        code && callback.searchParams.getAll("code").length === 1
          ? options.accept(code, callback.searchParams, `${origin}/auth/callback`)
          : null;

      if (accepted === null)
        return reject("The sign-in callback had an invalid code or registration.");

      consumed = true;
      Deferred.doneUnsafe(result, Effect.succeed(accepted));

      return { completed: true, accepted: true };
    };

    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: options.port ?? 0,
            fetch: (httpRequest, listener) => {
              const headers = {
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
                "Content-Type": "text/plain; charset=utf-8",
              };

              if (httpRequest.method !== "GET")
                return new Response("Not found", { status: 404, headers });

              const outcome = submit(new URL(httpRequest.url), `http://127.0.0.1:${listener.port}`);

              return outcome.completed
                ? callbackResponse(outcome.accepted, options.received)
                : new Response(outcome.message, { status: outcome.status, headers });
            },
          }),
        catch: () =>
          new SignInError({
            reason: "callback",
            message:
              options.port === null
                ? "Could not start the local sign-in callback listener."
                : `Could not listen for the sign-in callback on 127.0.0.1:${options.port}. Choose another callback port.`,
          }),
      }),
      // Drain the callback response before releasing the listener. Force-closing
      // here can reset the browser's connection as soon as the Deferred completes.
      (listener) => Effect.promise(() => listener.stop()),
    );

    const origin = `http://127.0.0.1:${server.port}`;

    return {
      state,
      redirectUri: `${origin}/auth/callback`,
      submitPasted: (pasted: string) => {
        const callback = URL.parse(pasted.trim());

        return callback === null
          ? ({ completed: false, status: 400, message: "Invalid callback URL." } as const)
          : submit(callback, origin);
      },
      authorization: Deferred.await(result),
    } satisfies Callback<A>;
  });
