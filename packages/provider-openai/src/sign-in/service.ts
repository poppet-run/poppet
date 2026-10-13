import { Console, Context, Effect, Layer } from "effect";

import { ConnectionError, requestedScopes, resource } from "#src/connection";
import { openBrowser } from "#src/sign-in/browser";
import { type Authorization, startCallback } from "#src/sign-in/callback";

export interface SignInRequest {
  readonly endpoint: string;
  readonly applicationName: string;
  readonly hostId: string;
  readonly clientId: string | null;
  readonly consent: boolean;
}

export class BrowserSignIn extends Context.Service<
  BrowserSignIn,
  {
    readonly authorize: (request: SignInRequest) => Effect.Effect<Authorization, ConnectionError>;
  }
>()("poppet/BrowserSignIn") {}

export const makeBrowserSignIn = (
  open: (url: string) => Effect.Effect<void, ConnectionError>,
  timeoutMs = 300_000,
) => ({
  authorize: (request: SignInRequest) =>
    // This scope owns the callback listener, including while waiting for the
    // browser. Success, failure, timeout, and interruption all close it.
    Effect.scoped(
      Effect.gen(function* () {
        const callback = yield* startCallback(request.clientId);
        const url = new URL(request.endpoint);
        url.search = new URLSearchParams({
          // The first sign-in asks for a registration. Later attempts reuse the
          // client ID returned by the callback and saved in credential storage.
          client_id: request.clientId ?? "dynamic_agent_client",
          ext_agent_host_id: request.hostId,
          response_type: "code",
          redirect_uri: callback.redirectUri,
          scope: requestedScopes,
          resource,
          state: callback.state,
          nonce: callback.nonce,
          code_challenge_method: "S256",
          code_challenge: callback.challenge,
        }).toString();

        if (request.clientId === null)
          url.searchParams.set("agent_name_hint", request.applicationName);

        if (request.consent) url.searchParams.set("prompt", "consent");

        yield* Console.log(
          `Continue with ChatGPT:\n${url.toString()}\nWaiting for the browser callback. Press Ctrl+C to cancel.`,
        );
        yield* open(url.toString()).pipe(
          Effect.catch(() =>
            Console.error("Could not open the system browser. Open the sign-in link above."),
          ),
        );

        return yield* callback.authorization;
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

export const BrowserSignInLive = Layer.succeed(BrowserSignIn, makeBrowserSignIn(openBrowser));
