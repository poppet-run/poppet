import { DateTime, Effect } from "effect";
import type { Redacted } from "effect";

import { CredentialStore } from "#src/auth/credentials";
import { credentialsFor, reconnect } from "#src/auth/state";
import { ConnectionError, planScope } from "#src/connection";
import type { Credentials, Identity } from "#src/connection";
import { OAuthClient } from "#src/oauth/client";
import { refreshBody } from "#src/oauth/tokens";

type AccessToken = Effect.Effect<Redacted.Redacted<string>, ConnectionError>;

export const accessTokenWorkflow = Effect.gen(function* () {
  const store = yield* CredentialStore;
  const oauth = yield* OAuthClient;

  const accessToken: AccessToken = Effect.gen(function* () {
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
        const exchange = (refreshToken: Redacted.Redacted<string>) =>
          Effect.gen(function* () {
            const refreshed = yield* restore(
              oauth.exchange(refreshBody(refreshToken, clientId)),
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

            const renewed = credentialsFor(refreshed, (yield* DateTime.nowAsDate).getTime(), {
              ...credentials,
              refreshToken,
            });

            if (!renewed?.accessToken || !renewed.expiresAt || refreshed.token_type !== "Bearer") {
              return yield* Effect.fail(
                new ConnectionError({
                  reason: "reconnect",
                  message: "OpenAI returned incomplete renewed credentials. Sign in again.",
                }),
              );
            }

            return renewed;
          });

        const verify = (replacement: Credentials) =>
          oauth
            .verifyIdentity(replacement.idToken, clientId, null)
            .pipe(
              Effect.tapError((error) =>
                error.reason === "temporary"
                  ? store.write({ ...confirmed, pendingRefresh: replacement })
                  : Effect.void,
              ),
            );

        let replacement: Credentials;
        let identity: Identity | null = null;

        if (pendingRefresh === undefined) {
          if (!credentials.refreshToken) {
            return yield* Effect.fail(reconnect());
          }

          replacement = yield* exchange(credentials.refreshToken);
        } else {
          // The saved renewal holds the only unused refresh token, so renew from it when its
          // identity token can no longer be verified, such as after it expires.
          const rotated = pendingRefresh.refreshToken;
          replacement = pendingRefresh;
          identity = yield* verify(pendingRefresh).pipe(
            Effect.catchIf(
              (error) => error.reason !== "temporary" && rotated !== null,
              () => Effect.succeed(null),
            ),
            Effect.tapError((error) =>
              error.reason === "temporary" ? Effect.void : store.write(confirmed),
            ),
          );

          if (identity === null && rotated !== null) {
            replacement = yield* exchange(rotated);
          }
        }

        if (identity === null && replacement.idToken !== credentials.idToken) {
          identity = yield* verify(replacement);
        }

        if (identity !== null && identity.subject !== connection.identity?.subject) {
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

        yield* store.write({ ...confirmed, credentials: replacement });

        return replacement;
      }),
    );

    const replacement = yield* renew;

    // A saved renewal can outlive its access token, so refresh it again once promoted.
    if (
      pendingRefresh !== undefined &&
      (replacement.expiresAt ?? 0) <= (yield* DateTime.nowAsDate).getTime() + 60_000
    ) {
      return yield* accessToken;
    }

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

  return accessToken;
});
