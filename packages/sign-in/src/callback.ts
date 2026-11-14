import { randomBytes } from "node:crypto";

import { Deferred, Effect } from "effect";

import { SignInError } from "#src/errors";
import { callbackResponse } from "#src/page";

export type CallbackOutcome =
  | { readonly completed: true; readonly accepted: boolean }
  | { readonly completed: false; readonly status: 400 | 404 | 410; readonly message: string };

export interface CallbackOptions<A> {
  readonly port: number | null;
  readonly service: string;
  readonly received: string;
  readonly accept: (code: string, parameters: URLSearchParams, redirectUri: string) => A | null;
}

export interface Callback<A> {
  readonly state: string;
  readonly redirectUri: string;
  readonly submitPasted: (pasted: string) => CallbackOutcome;
  readonly authorization: Effect.Effect<A, SignInError>;
}

export const startCallback = <A>(options: CallbackOptions<A>) =>
  Effect.gen(function* () {
    const state = randomBytes(32).toString("base64url");
    const result = yield* Deferred.make<A, SignInError>();
    let consumed = false;

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
