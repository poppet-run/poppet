import { DateTime, Effect } from "effect";

import { CredentialStore } from "#src/auth/credentials";
import { credentialsFor, reconnect } from "#src/auth/state";
import { ConnectionError, planScope } from "#src/connection";
import { OAuthClient } from "#src/oauth/client";
import { refreshBody } from "#src/oauth/tokens";

export const accessTokenWorkflow = Effect.gen(function* () {
  const store = yield* CredentialStore;
  const oauth = yield* OAuthClient;

  return Effect.gen(function* () {
    const connection = yield* store.read;

    if (connection === null) {
      return yield* Effect.fail(reconnect());
    }

    const credentials = connection.credentials;
    const clientId = connection.clientId;

    if (!credentials || !clientId || !connection.identity) {
      return yield* Effect.fail(reconnect());
    }

    if (!credentials.scopes.includes(planScope)) {
      return yield* Effect.fail(
        new ConnectionError({
          reason: "plan_disabled",
          message:
            "ChatGPT plan usage was not granted. Run provider login openai-chatgpt to enable it.",
        }),
      );
    }

    const now = (yield* DateTime.nowAsDate).getTime();

    if (
      connection.pendingRefresh === undefined &&
      credentials.accessToken &&
      credentials.expiresAt !== null &&
      credentials.expiresAt > now + 60_000
    ) {
      return credentials.accessToken;
    }

    const { pendingRefresh, ...confirmed } = connection;

    const renew = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        let replacement = pendingRefresh;

        if (replacement === undefined) {
          if (!credentials.refreshToken) {
            return yield* Effect.fail(reconnect());
          }

          const refreshed = yield* restore(
            oauth.exchange(refreshBody(credentials.refreshToken, clientId)),
          ).pipe(
            Effect.catchTag("ConnectionError", (error) => {
              if (error.reason !== "reconnect") {
                return Effect.fail(error);
              }

              return store
                .write({ ...confirmed, credentials: null, verification: null })
                .pipe(Effect.andThen(Effect.fail(error)));
            }),
          );

          const renewed = credentialsFor(
            refreshed,
            (yield* DateTime.nowAsDate).getTime(),
            credentials,
          );

          if (!renewed?.accessToken || !renewed.expiresAt || refreshed.token_type !== "Bearer") {
            return yield* Effect.fail(
              new ConnectionError({
                reason: "reconnect",
                message: "OpenAI returned incomplete renewed credentials. Sign in again.",
              }),
            );
          }

          replacement = renewed;
        }

        if (pendingRefresh !== undefined || replacement.idToken !== credentials.idToken) {
          const identity = yield* oauth.verifyIdentity(replacement.idToken, clientId, null).pipe(
            Effect.tapError((error) => {
              if (error.reason === "temporary") {
                return store.write({ ...confirmed, pendingRefresh: replacement });
              }

              return pendingRefresh === undefined ? Effect.void : store.write(confirmed);
            }),
          );

          if (identity.subject !== connection.identity?.subject) {
            if (pendingRefresh !== undefined) {
              yield* store.write(confirmed);
            }

            return yield* Effect.fail(
              new ConnectionError({
                reason: "identity",
                message: "The renewed token did not match the saved account.",
              }),
            );
          }
        }

        yield* store.write({ ...confirmed, credentials: replacement });

        return replacement;
      }),
    );

    const replacement = yield* renew;

    if (!replacement.scopes.includes(planScope)) {
      return yield* Effect.fail(
        new ConnectionError({
          reason: "plan_disabled",
          message:
            "The renewed connection no longer permits ChatGPT plan usage. Run provider login openai-chatgpt to enable it.",
        }),
      );
    }

    if (!replacement.accessToken) {
      return yield* Effect.fail(reconnect());
    }

    return replacement.accessToken;
  });
});
