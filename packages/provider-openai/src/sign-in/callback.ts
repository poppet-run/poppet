import { createHash, randomBytes } from "node:crypto";

import { Deferred, Effect, Redacted } from "effect";

import { ConnectionError } from "#src/connection";
import { callbackResponse } from "#src/sign-in/page";

/** A validated browser callback plus the local verifier needed for the code exchange. */
export interface Authorization {
  readonly code: Redacted.Redacted<string>;
  readonly verifier: Redacted.Redacted<string>;
  readonly nonce: string;
  readonly clientId: string;
  readonly redirectUri: string;
}

/** How a callback ended the attempt, or why it was ignored so a valid one can still arrive. */
export type CallbackOutcome =
  | { readonly completed: true; readonly accepted: boolean }
  | { readonly completed: false; readonly status: 400 | 404 | 410; readonly message: string };

export const startCallback = (selectedClientId: string | null, port: number | null) =>
  Effect.gen(function* () {
    // State links the callback to this attempt; nonce does the same for the ID
    // token. PKCE later proves that the code exchange holds this verifier.
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(64).toString("base64url");
    // The listener or a pasted callback URL completes this Deferred once,
    // allowing the sign-in Effect to wait for either without polling.
    const result = yield* Deferred.make<Authorization, ConnectionError>();
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
        Deferred.doneUnsafe(result, Effect.fail(new ConnectionError({ reason, message })));

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
        return reject("ChatGPT sign-in was declined or could not be completed.", "denied");

      const code = callback.searchParams.get("code");
      const returnedClientId = callback.searchParams.get("client_id");
      const clientId = returnedClientId ?? selectedClientId;

      if (
        !code ||
        callback.searchParams.getAll("code").length !== 1 ||
        callback.searchParams.getAll("client_id").length > 1 ||
        !clientId ||
        clientId === "dynamic_agent_client" ||
        (selectedClientId !== null && clientId !== selectedClientId)
      )
        return reject("The sign-in callback had an invalid code or registration.");

      consumed = true;
      Deferred.doneUnsafe(
        result,
        Effect.succeed({
          code: Redacted.make(code),
          verifier: Redacted.make(verifier),
          nonce,
          clientId,
          redirectUri: `${origin}/auth/callback`,
        }),
      );

      return { completed: true, accepted: true };
    };

    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: port ?? 0,
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
                ? callbackResponse(outcome.accepted)
                : new Response(outcome.message, { status: outcome.status, headers });
            },
          }),
        catch: () =>
          new ConnectionError({
            reason: "callback",
            message:
              port === null
                ? "Could not start the local sign-in callback listener."
                : `Could not listen for the sign-in callback on 127.0.0.1:${port}. Choose another callback port.`,
          }),
      }),
      // Drain the callback response before releasing the listener. Force-closing
      // here can reset the browser's connection as soon as the Deferred completes.
      (listener) => Effect.promise(() => listener.stop()),
    );

    const origin = `http://127.0.0.1:${server.port}`;

    return {
      state,
      nonce,
      redirectUri: `${origin}/auth/callback`,
      challenge: createHash("sha256").update(verifier).digest("base64url"),
      /** Checks a callback URL copied from a browser that could not reach the listener. */
      submitPasted: (pasted: string) => {
        const callback = URL.parse(pasted.trim());

        return callback === null
          ? ({ completed: false, status: 400, message: "Invalid callback URL." } as const)
          : submit(callback, origin);
      },
      authorization: Deferred.await(result),
    };
  });
