import { Console, Context, Effect, Layer } from "effect";

import { ConnectionError, requestedScopes, resource } from "#src/connection";
import { openBrowser, remoteSession } from "#src/sign-in/browser";
import { type Authorization, startCallback } from "#src/sign-in/callback";

/** Browser authorization settings; a null clientId requests a new client registration. */
export interface SignInRequest {
  readonly endpoint: string;
  readonly applicationName: string;
  readonly hostId: string;
  readonly clientId: string | null;
  readonly consent: boolean;
  /** Skips the system browser and accepts a callback URL pasted into the terminal. */
  readonly noBrowser: boolean;
  /** A fixed listener port for SSH forwarding; null picks any free port. */
  readonly callbackPort: number | null;
  /** Reads one pasted line when the browser cannot reach the listener. */
  readonly paste: Effect.Effect<string, ConnectionError>;
}

/** Login command choices for how the browser reaches this attempt. */
export type SignInOptions = Pick<SignInRequest, "noBrowser" | "callbackPort" | "paste">;

/** Owns browser authorization and its temporary callback listener through completion or timeout. */
export class BrowserSignIn extends Context.Service<
  BrowserSignIn,
  {
    readonly authorize: (request: SignInRequest) => Effect.Effect<Authorization, ConnectionError>;
  }
>()("poppet/BrowserSignIn") {}

export const makeBrowserSignIn = (
  open: (url: string) => Effect.Effect<void, ConnectionError>,
  timeoutMs = 300_000,
  // True when the system browser would open on another machine or nowhere.
  remote = false,
) => ({
  authorize: (request: SignInRequest) =>
    // This scope owns the callback listener, including while waiting for the
    // browser. Success, failure, timeout, and interruption all close it.
    Effect.scoped(
      Effect.gen(function* () {
        const callback = yield* startCallback(request.clientId, request.callbackPort);
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

        if (!request.noBrowser && !remote) {
          yield* Console.log(
            `Continue with ChatGPT:\n${url.toString()}\nWaiting for the browser callback. Press Ctrl+C to cancel.`,
          );
          yield* open(url.toString()).pipe(
            Effect.catch(() =>
              Console.error("Could not open the system browser. Open the sign-in link above."),
            ),
          );

          return yield* callback.authorization;
        }

        yield* Console.log(
          `Open this link in a browser on any device to continue with ChatGPT:\n${url.toString()}\n` +
            `If that browser then shows an error page for ${callback.redirectUri}, copy the full address from its address bar and paste it here.`,
        );

        // Keep reading until a pasted URL completes the attempt. A forwarded
        // browser callback can still finish first and interrupts the prompt.
        const pasted = Effect.gen(function* () {
          while (true) {
            const line = yield* request.paste;

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
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(
            new ConnectionError({
              reason: "callback",
              message: "Sign-in timed out. Start a new sign-in.",
            }),
          ),
      }),
    ),
});

export const BrowserSignInLive = Layer.sync(BrowserSignIn, () =>
  makeBrowserSignIn(openBrowser, undefined, remoteSession(process.env, process.platform)),
);
