import { DateTime, Effect } from "effect";

import { ConnectionError, planScope } from "../connection.ts";
import { OAuthClient } from "../oauth/client.ts";
import { refreshBody } from "../oauth/tokens.ts";
import { CredentialStore } from "./credentials.ts";
import { credentialsFor, reconnect } from "./state.ts";

export const accessTokenWorkflow = Effect.gen(function* () {
  const store = yield* CredentialStore;
  const oauth = yield* OAuthClient;

  return Effect.gen(function* () {
    const connection = yield* store.read;
    const credentials = connection.credentials;
    const clientId = connection.clientId;

    if (!credentials || !clientId || !connection.identity) return yield* Effect.fail(reconnect());

    if (!credentials.scopes.includes(planScope))
      return yield* Effect.fail(
        new ConnectionError({
          reason: "plan_disabled",
          message:
            "ChatGPT plan usage was not granted. Run bun run start auth login --consent to enable it.",
        }),
      );
    const now = (yield* DateTime.nowAsDate).getTime();

    if (
      credentials.accessToken &&
      credentials.expiresAt !== null &&
      credentials.expiresAt > now + 60_000
    )
      return credentials.accessToken;

    if (!credentials.refreshToken) return yield* Effect.fail(reconnect());

    const refreshed = yield* oauth.exchange(refreshBody(credentials.refreshToken, clientId)).pipe(
      Effect.catchTag("ConnectionError", (error) =>
        Effect.gen(function* () {
          if (error.reason === "reconnect")
            yield* store.write({ ...connection, credentials: null, verification: null });

          return yield* Effect.fail(error);
        }),
      ),
    );

    if (refreshed.id_token) {
      const identity = yield* oauth.verifyIdentity(refreshed.id_token, clientId, null);

      if (identity.subject !== connection.identity.subject)
        return yield* Effect.fail(
          new ConnectionError({
            reason: "identity",
            message: "The renewed token did not match the saved account.",
          }),
        );
    }

    const replacement = credentialsFor(
      refreshed,
      (yield* DateTime.nowAsDate).getTime(),
      credentials,
    );

    if (
      !replacement ||
      !replacement.accessToken ||
      !replacement.expiresAt ||
      refreshed.token_type !== "Bearer"
    )
      return yield* Effect.fail(
        new ConnectionError({
          reason: "reconnect",
          message: "OpenAI returned incomplete renewed credentials. Sign in again.",
        }),
      );
    yield* store.write({ ...connection, credentials: replacement });

    if (!replacement.scopes.includes(planScope))
      return yield* Effect.fail(
        new ConnectionError({
          reason: "plan_disabled",
          message:
            "The renewed connection no longer permits ChatGPT plan usage. Sign in with --consent.",
        }),
      );

    return replacement.accessToken;
  });
});
