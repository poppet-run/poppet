import { Context, DateTime, Effect, Layer, Redacted, Semaphore } from "effect";

import type { ConnectionError } from "../connection.ts";
import { OAuthClient } from "../oauth/client.ts";
import { CredentialStore } from "./credentials.ts";
import { loginWorkflow } from "./login.ts";
import { accessTokenWorkflow } from "./refresh.ts";
import { type ConnectionStatus, statusFor } from "./state.ts";

interface AuthOperations {
  readonly login: (consent: boolean) => Effect.Effect<ConnectionStatus, ConnectionError>;
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

        yield* store.write({ ...connection, credentials: null, verification: null });

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
