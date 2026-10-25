import { Context, DateTime, Effect, Layer, Redacted } from "effect";

import { CredentialStore } from "#src/auth/credentials";
import { loginWorkflow } from "#src/auth/login";
import { accessTokenWorkflow } from "#src/auth/refresh";
import { type ConnectionStatus, statusFor, reconnect } from "#src/auth/state";
import type { ConnectionError } from "#src/connection";
import { OAuthClient } from "#src/oauth/client";
import type { SignInOptions } from "#src/sign-in/service";

interface AuthOperations {
  readonly login: (options: SignInOptions) => Effect.Effect<ConnectionStatus, ConnectionError>;
  readonly status: Effect.Effect<ConnectionStatus, ConnectionError>;
  /** Reads current credentials and refreshes near expiry while holding the auth permit. */
  readonly accessToken: Effect.Effect<Redacted.Redacted<string>, ConnectionError>;
  /** Deletes local connection details first; false means remote revocation was not confirmed. */
  readonly signOut: Effect.Effect<boolean, ConnectionError>;
  readonly recordVerification: (model: string) => Effect.Effect<void, ConnectionError>;
}

/** Serializes ChatGPT sign-in, token refresh, status reads, and sign-out. */
export class ChatGPTAuth extends Context.Service<ChatGPTAuth, AuthOperations>()(
  "poppet/ChatGPTAuth",
) {}

export const ChatGPTAuthLive = Layer.effect(
  ChatGPTAuth,
  Effect.gen(function* () {
    const store = yield* CredentialStore;
    const oauth = yield* OAuthClient;
    const login = yield* loginWorkflow;
    const accessToken = yield* accessTokenWorkflow;

    // The store's process-wide permit serializes credential updates and status
    // reads. In particular, two requests cannot renew the same refresh token.
    const signOut = store.withPermit(
      Effect.gen(function* () {
        let revoked = true;

        const connection = yield* store.read.pipe(
          Effect.catchTag("ConnectionError", () => {
            // Corrupt or unreadable details still need deleting; remote revocation
            // cannot be confirmed without their token and registration.
            revoked = false;

            return Effect.succeed(null);
          }),
        );

        // Delete local identity before contacting the remote endpoint so failure
        // or interruption cannot leave provider details behind.
        yield* store.remove;

        if (connection?.credentials?.refreshToken && connection.clientId) {
          revoked = yield* oauth
            .revoke(connection.credentials.refreshToken, connection.clientId)
            .pipe(Effect.isSuccess);
        }

        return revoked;
      }),
    );

    const recordVerification = (model: string) =>
      store.withPermit(
        Effect.gen(function* () {
          const connection = yield* store.read;

          if (connection === null) return yield* Effect.fail(reconnect());
          yield* store.write({
            ...connection,
            verification: { model, at: (yield* DateTime.nowAsDate).getTime() },
          });
        }),
      );

    return {
      login: (options: SignInOptions) => store.withPermit(login(options)),
      accessToken: store.withPermit(accessToken),
      signOut,
      recordVerification,
      status: store.withPermit(store.read.pipe(Effect.map(statusFor))),
    } satisfies AuthOperations;
  }),
);
