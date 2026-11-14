import { ProviderEnvironment } from "@poppet/provider";
import { DateTime, Effect, Redacted } from "effect";

import { CredentialStore } from "#src/auth/credentials";
import { credentialsFor, statusFor } from "#src/auth/state";
import { ConnectionError, planScope, resource } from "#src/connection";
import { OAuthClient } from "#src/oauth/client";
import { BrowserSignIn, type SignInOptions } from "#src/sign-in/service";

export const loginWorkflow = Effect.gen(function* () {
  const config = yield* ProviderEnvironment;
  const store = yield* CredentialStore;
  const oauth = yield* OAuthClient;
  const browser = yield* BrowserSignIn;

  return (options: SignInOptions) =>
    Effect.gen(function* () {
      const saved = yield* store.initialize;
      const endpoint = yield* oauth.authorizationEndpoint;

      const authorization = yield* browser.authorize({
        endpoint,
        applicationName: config.applicationName,
        hostId: saved.hostId,
        clientId: saved.clientId,
        consent: !statusFor(saved).planUsage,
        ...options,
      });

      if (saved.clientId !== null && saved.clientId !== authorization.clientId)
        return yield* Effect.fail(
          new ConnectionError({
            reason: "identity",
            message: "The callback did not match the saved registration.",
          }),
        );
      const registered = { ...saved, clientId: authorization.clientId };
      yield* store.write(registered);

      const tokens = yield* oauth.exchange(
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: authorization.clientId,
          code: Redacted.value(authorization.code),
          code_verifier: Redacted.value(authorization.verifier),
          redirect_uri: authorization.redirectUri,
          resource,
        }),
      );

      if (!tokens.id_token)
        return yield* Effect.fail(
          new ConnectionError({
            reason: "identity",
            message: "OpenAI did not return an identity token.",
          }),
        );

      const identity = yield* oauth.verifyIdentity(
        tokens.id_token,
        authorization.clientId,
        authorization.nonce,
      );

      if (saved.identity !== null && saved.identity.subject !== identity.subject)
        return yield* Effect.fail(
          new ConnectionError({
            reason: "identity",
            message:
              "The signed-in account did not match the saved registration. Existing credentials were retained.",
          }),
        );

      const credentials = credentialsFor(tokens, (yield* DateTime.nowAsDate).getTime(), null);

      if (
        credentials?.scopes.includes(planScope) &&
        (!credentials.accessToken || !credentials.expiresAt || tokens.token_type !== "Bearer")
      )
        return yield* Effect.fail(
          new ConnectionError({
            reason: "identity",
            message: "OpenAI granted plan usage without complete bearer credentials.",
          }),
        );
      const connection = { ...registered, identity, credentials, verification: null };
      yield* store.write(connection);

      return statusFor(connection);
    });
});
