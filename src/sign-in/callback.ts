import { createHash, randomBytes } from "node:crypto";

import { Deferred, Effect, Redacted } from "effect";

import { ConnectionError } from "../connection.ts";
import { callbackResponse } from "./page.ts";

export interface Authorization {
  readonly code: Redacted.Redacted<string>;
  readonly verifier: Redacted.Redacted<string>;
  readonly nonce: string;
  readonly clientId: string;
  readonly redirectUri: string;
}

export const startCallback = (selectedClientId: string | null) =>
  Effect.gen(function* () {
    // State links the callback to this attempt; nonce does the same for the ID
    // token. PKCE later proves that the code exchange holds this verifier.
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(64).toString("base64url");
    // The HTTP handler completes this Deferred once, allowing the sign-in Effect
    // to wait for the callback without polling.
    const result = yield* Deferred.make<Authorization, ConnectionError>();
    let consumed = false;

    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (httpRequest, listener) => {
              const callback = new URL(httpRequest.url);

              const headers = {
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
                "Content-Type": "text/plain; charset=utf-8",
              };

              if (httpRequest.method !== "GET" || callback.pathname !== "/auth/callback")
                return new Response("Not found", { status: 404, headers });

              if (callback.origin !== `http://127.0.0.1:${listener.port}`)
                return new Response("Invalid callback host.", { status: 400, headers });

              if (consumed)
                return new Response("Sign-in attempt already completed.", {
                  status: 410,
                  headers,
                });

              const reject = (message: string, reason: "callback" | "denied" = "callback") => {
                consumed = true;
                Deferred.doneUnsafe(result, Effect.fail(new ConnectionError({ reason, message })));

                return callbackResponse(false);
              };

              // Check state before accepting either a code or a reported sign-in error.
              if (
                callback.searchParams.getAll("state").length !== 1 ||
                callback.searchParams.get("state") !== state
              )
                return reject("The sign-in callback state did not match. Start a new sign-in.");

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
                  redirectUri: `http://127.0.0.1:${listener.port}/auth/callback`,
                }),
              );

              return callbackResponse(true);
            },
          }),
        catch: () =>
          new ConnectionError({
            reason: "callback",
            message: "Could not start the local sign-in callback listener.",
          }),
      }),
      // Drain the callback response before releasing the listener. Force-closing
      // here can reset the browser's connection as soon as the Deferred completes.
      (listener) => Effect.promise(() => listener.stop()),
    );

    const redirectUri = `http://127.0.0.1:${server.port}/auth/callback`;

    return {
      state,
      nonce,
      redirectUri,
      challenge: createHash("sha256").update(verifier).digest("base64url"),
      authorization: Deferred.await(result),
    };
  });
