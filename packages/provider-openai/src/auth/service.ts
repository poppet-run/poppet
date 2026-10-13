import { Context, DateTime, Effect, Layer, Redacted, Semaphore } from "effect";

import { CredentialStore } from "#src/auth/credentials";
import { loginWorkflow } from "#src/auth/login";
import { accessTokenWorkflow } from "#src/auth/refresh";
import { type ConnectionStatus, statusFor } from "#src/auth/state";
import type { ConnectionError } from "#src/connection";
import { OAuthClient } from "#src/oauth/client";

interface AuthOperations {
  readonly login: (consent: boolean) => Effect.Effect<ConnectionStatus, ConnectionError>;
  readonly status: Effect.Effect<ConnectionStatus, ConnectionError>;
  readonly accessToken: Effect.Effect<Redacted.Redacted<string>, ConnectionError>;
  readonly signOut: Effect.Effect<boolean, ConnectionError>;
  readonly recordVerification: (model: string) => Effect.Effect<void, ConnectionError>;
}

// This tag identifies the auth service in Effect's context. yield* ChatGPTAuth
// retrieves the implementation supplied by the layer below.
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
    // One permit serializes credential updates and status reads. In particular,
    // two callers cannot renew the same refresh token at the same time.
    const semaphore = yield* Semaphore.make(1);

    const signOut = semaphore.withPermit(
      Effect.gen(function* () {
        const connection = yield* store.read;
        let revoked = true;

        if (connection.credentials?.refreshToken && connection.clientId) {
          revoked = yield* oauth
            .revoke(connection.credentials.refreshToken, connection.clientId)
            .pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            );
        }

        // Clear account data even if remote revocation fails. Keep the registration
        // so the next sign-in can reuse it.
        yield* store.write({
          ...connection,
          identity: null,
          credentials: null,
          verification: null,
        });

        return revoked;
      }),
    );

    const recordVerification = (model: string) =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const connection = yield* store.read;
          yield* store.write({
            ...connection,
            verification: { model, at: (yield* DateTime.nowAsDate).getTime() },
          });
        }),
      );

    return {
      login: (consent) => semaphore.withPermit(login(consent)),
      accessToken: semaphore.withPermit(accessToken),
      signOut,
      recordVerification,
      status: semaphore.withPermit(store.read.pipe(Effect.map(statusFor))),
    } satisfies AuthOperations;
  }),
);
