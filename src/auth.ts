import { Context, DateTime, Effect, Layer, Redacted, Semaphore } from "effect";

import { AppConfig } from "./config.ts";
import {
  type Connection,
  ConnectionError,
  type Credentials,
  planScope,
  resource,
} from "./connection.ts";
import { CredentialStore } from "./credentials.ts";
import { OAuthClient, refreshBody, type TokenReply } from "./oauth.ts";
import { BrowserSignIn } from "./sign-in.ts";

export interface ConnectionStatus {
  readonly connected: boolean;
  readonly email: string | null;
  readonly clientId: string | null;
  readonly planUsage: boolean;
  readonly expiresAt: number | null;
  readonly verification: Connection["verification"];
}

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

const reconnect = () =>
  new ConnectionError({
    reason: "reconnect",
    message: "Sign in first with bun run start auth login.",
  });

const statusFor = (connection: Connection): ConnectionStatus => ({
  connected: connection.identity !== null && connection.credentials !== null,
  email: connection.identity?.email ?? null,
  clientId: connection.clientId,
  planUsage: connection.credentials?.scopes.includes(planScope) ?? false,
  expiresAt: connection.credentials?.expiresAt ?? null,
  verification: connection.verification,
});

const credentialsFor = (
  reply: TokenReply,
  now: number,
  previous: Credentials | null,
): Credentials | null => {
  const idToken = reply.id_token ?? previous?.idToken;

  if (!idToken) return null;

  return {
    accessToken: reply.access_token ?? null,
    refreshToken: reply.refresh_token ?? previous?.refreshToken ?? null,
    idToken,
    expiresAt: reply.expires_in === undefined ? null : now + reply.expires_in * 1000,
    scopes:
      reply.scope === undefined
        ? (previous?.scopes ?? [])
        : reply.scope.split(/\s+/).filter(Boolean),
  };
};

export const ChatGPTAuthLive = Layer.effect(
  ChatGPTAuth,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const store = yield* CredentialStore;
    const oauth = yield* OAuthClient;
    const browser = yield* BrowserSignIn;
    const semaphore = yield* Semaphore.make(1);

    const login = (consent: boolean) =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const saved = yield* store.read;
          const endpoint = yield* oauth.authorizationEndpoint;

          const authorization = yield* browser.authorize({
            endpoint,
            applicationName: config.applicationName,
            hostId: saved.hostId,
            clientId: saved.clientId,
            consent,
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

          const credentials = credentialsFor(
            tokens,
            yield* DateTime.nowAsDate.pipe(Effect.map((date) => date.getTime())),
            null,
          );

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
        }),
      );

    const accessToken = semaphore.withPermit(
      Effect.gen(function* () {
        const connection = yield* store.read;
        const credentials = connection.credentials;
        const clientId = connection.clientId;

        if (!credentials || !clientId || !connection.identity)
          return yield* Effect.fail(reconnect());

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

        const refreshed = yield* oauth
          .exchange(refreshBody(credentials.refreshToken, clientId))
          .pipe(
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
      }),
    );

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
      login,
      accessToken,
      signOut,
      recordVerification,
      status: semaphore.withPermit(store.read.pipe(Effect.map(statusFor))),
    } satisfies AuthOperations;
  }),
);
