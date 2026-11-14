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
  readonly accessToken: Effect.Effect<Redacted.Redacted<string>, ConnectionError>;
  readonly signOut: Effect.Effect<boolean, ConnectionError>;
  readonly recordVerification: (model: string) => Effect.Effect<void, ConnectionError>;
}

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

    const signOut = store.withPermit(
      Effect.gen(function* () {
        let revoked = true;

        const connection = yield* store.read.pipe(
          Effect.catchTag("ConnectionError", () => {
            revoked = false;

            return Effect.succeed(null);
          }),
        );

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
