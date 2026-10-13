import { createHash, randomBytes } from "node:crypto";

import { Console, Context, Deferred, Effect, Layer, Redacted } from "effect";

import { ConnectionError, requestedScopes, resource } from "./connection.ts";
import { callbackResponse } from "./sign-in-page.ts";

export interface SignInRequest {
  readonly endpoint: string;
  readonly applicationName: string;
  readonly hostId: string;
  readonly clientId: string | null;
  readonly consent: boolean;
}

export interface Authorization {
  readonly code: Redacted.Redacted<string>;
  readonly verifier: Redacted.Redacted<string>;
  readonly nonce: string;
  readonly clientId: string;
  readonly redirectUri: string;
}

export class BrowserSignIn extends Context.Service<
  BrowserSignIn,
  {
    readonly authorize: (request: SignInRequest) => Effect.Effect<Authorization, ConnectionError>;
  }
>()("poppet/BrowserSignIn") {}

export const makeBrowserSignIn = (
  openBrowser: (url: string) => Effect.Effect<void, ConnectionError>,
  timeoutMs = 300_000,
) => ({
  authorize: (request: SignInRequest) =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = randomBytes(32).toString("base64url");
        const nonce = randomBytes(32).toString("base64url");
        const verifier = randomBytes(64).toString("base64url");
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
                    Deferred.doneUnsafe(
                      result,
                      Effect.fail(new ConnectionError({ reason, message })),
                    );

                    return callbackResponse(false);
                  };

                  if (
                    callback.searchParams.getAll("state").length !== 1 ||
                    callback.searchParams.get("state") !== state
                  )
                    return reject("The sign-in callback state did not match. Start a new sign-in.");

                  if (callback.searchParams.has("error"))
                    return reject(
                      "ChatGPT sign-in was declined or could not be completed.",
                      "denied",
                    );

                  const code = callback.searchParams.get("code");
                  const returnedClientId = callback.searchParams.get("client_id");
                  const clientId = returnedClientId ?? request.clientId;

                  if (
                    !code ||
                    callback.searchParams.getAll("code").length !== 1 ||
                    callback.searchParams.getAll("client_id").length > 1 ||
                    !clientId ||
                    clientId === "dynamic_agent_client" ||
                    (request.clientId !== null && clientId !== request.clientId)
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
        const url = new URL(request.endpoint);
        url.search = new URLSearchParams({
          client_id: request.clientId ?? "dynamic_agent_client",
          ext_agent_host_id: request.hostId,
          response_type: "code",
          redirect_uri: redirectUri,
          scope: requestedScopes,
          resource,
          state,
          nonce,
          code_challenge_method: "S256",
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        }).toString();

        if (request.clientId === null)
          url.searchParams.set("agent_name_hint", request.applicationName);

        if (request.consent) url.searchParams.set("prompt", "consent");

        yield* Console.log(
          `Continue with ChatGPT:\n${url.toString()}\nWaiting for the browser callback. Press Ctrl+C to cancel.`,
        );
        yield* openBrowser(url.toString()).pipe(
          Effect.catch(() =>
            Console.error("Could not open the system browser. Open the sign-in link above."),
          ),
        );

        return yield* Deferred.await(result);
      }),
    ).pipe(
      Effect.timeout(timeoutMs),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          new ConnectionError({
            reason: "callback",
            message: "Sign-in timed out. Start a new sign-in.",
          }),
        ),
      ),
    ),
});

const browserError = () =>
  new ConnectionError({ reason: "callback", message: "Could not open the system browser." });

const openBrowser = (url: string) =>
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

export const BrowserSignInLive = Layer.succeed(BrowserSignIn, makeBrowserSignIn(openBrowser));
