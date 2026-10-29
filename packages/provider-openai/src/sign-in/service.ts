import { createHash, randomBytes } from "node:crypto";

import { authorizeInBrowser, openBrowser, remoteSession, startCallback } from "@poppet/sign-in";
import { Context, Effect, Layer, Redacted } from "effect";

import { ConnectionError, requestedScopes, resource } from "#src/connection";

/** A validated browser callback plus the local verifier needed for the code exchange. */
export interface Authorization {
  readonly code: Redacted.Redacted<string>;
  readonly verifier: Redacted.Redacted<string>;
  readonly nonce: string;
  readonly clientId: string;
  readonly redirectUri: string;
}

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
  open: (url: string) => Effect.Effect<void, unknown>,
  timeoutMs = 300_000,
  // True when the system browser would open on another machine or nowhere.
  remote = false,
) => ({
  authorize: (request: SignInRequest) =>
    // This scope owns the callback listener, including while waiting for the
    // browser. Success, failure, timeout, and interruption all close it.
    Effect.scoped(
      Effect.gen(function* () {
        // Nonce links the ID token to this attempt. PKCE later proves that the code
        // exchange holds this verifier.
        const nonce = randomBytes(32).toString("base64url");
        const verifier = randomBytes(64).toString("base64url");
        const selected = request.clientId;

        const callback = yield* startCallback({
          port: request.callbackPort,
          service: "ChatGPT",
          received:
            "Return to your terminal while Poppet finishes checking your identity and ChatGPT permissions.",
          accept: (code, parameters, redirectUri): Authorization | null => {
            const clientId = parameters.get("client_id") ?? selected;

            if (
              parameters.getAll("client_id").length > 1 ||
              !clientId ||
              clientId === "dynamic_agent_client" ||
              (selected !== null && clientId !== selected)
            )
              return null;

            return {
              code: Redacted.make(code),
              verifier: Redacted.make(verifier),
              nonce,
              clientId,
              redirectUri,
            };
          },
        });

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
          nonce,
          code_challenge_method: "S256",
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        }).toString();

        if (request.clientId === null)
          url.searchParams.set("agent_name_hint", request.applicationName);

        if (request.consent) url.searchParams.set("prompt", "consent");

        return yield* authorizeInBrowser(callback, url.toString(), {
          service: "ChatGPT",
          noBrowser: request.noBrowser,
          remote,
          paste: request.paste,
          open,
          timeoutMs,
        });
      }),
    ).pipe(
      Effect.catchTag("SignInError", (error) =>
        Effect.fail(new ConnectionError({ reason: error.reason, message: error.message })),
      ),
    ),
});

export const BrowserSignInLive = Layer.sync(BrowserSignIn, () =>
  makeBrowserSignIn(openBrowser, undefined, remoteSession(process.env, process.platform)),
);
