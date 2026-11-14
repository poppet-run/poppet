import { createHash, randomBytes } from "node:crypto";

import { authorizeInBrowser, openBrowser, remoteSession, startCallback } from "@poppet/sign-in";
import { Context, Effect, Layer, Redacted } from "effect";

import { ConnectionError, requestedScopes, resource } from "#src/connection";

export interface Authorization {
  readonly code: Redacted.Redacted<string>;
  readonly verifier: Redacted.Redacted<string>;
  readonly nonce: string;
  readonly clientId: string;
  readonly redirectUri: string;
}

export interface SignInRequest {
  readonly endpoint: string;
  readonly applicationName: string;
  readonly hostId: string;
  readonly clientId: string | null;
  readonly consent: boolean;
  readonly noBrowser: boolean;
  readonly callbackPort: number | null;
  readonly paste: Effect.Effect<string, ConnectionError>;
}

export type SignInOptions = Pick<SignInRequest, "noBrowser" | "callbackPort" | "paste">;

export class BrowserSignIn extends Context.Service<
  BrowserSignIn,
  {
    readonly authorize: (request: SignInRequest) => Effect.Effect<Authorization, ConnectionError>;
  }
>()("poppet/BrowserSignIn") {}

export const makeBrowserSignIn = (
  open: (url: string) => Effect.Effect<void, unknown>,
  timeoutMs = 300_000,
  remote = false,
) => ({
  authorize: (request: SignInRequest) =>
    Effect.scoped(
      Effect.gen(function* () {
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
