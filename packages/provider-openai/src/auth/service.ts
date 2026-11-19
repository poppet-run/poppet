import { Context, DateTime, Effect, Layer, Redacted, Result } from "effect";

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
  readonly signOut: (forget?: boolean) => Effect.Effect<boolean, ConnectionError>;
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

    const signOut = (forget = false) =>
      store.withPermit(
        Effect.gen(function* () {
          const saved = yield* Effect.result(store.read);

          if (Result.isFailure(saved)) {
            yield* store.remove;

            return false;
          }

          const connection = saved.success;

          if (connection === null) return true;

          const clear = forget
            ? store.remove
            : store.write({ ...connection, credentials: null, verification: null });

          const refreshToken = connection.credentials?.refreshToken;

          if (refreshToken && connection.clientId)
            return yield* oauth.revoke(refreshToken, connection.clientId).pipe(
              Effect.isSuccess,
              Effect.onExit(() => clear),
            );

          yield* clear;

          return true;
        }),
      );

    const recordVerification = (model: string) =>
      store.withPermit(
        Effect.gen(function* () {
          const connection = yield* store.read;

          if (!connection?.credentials) return yield* Effect.fail(reconnect());
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
