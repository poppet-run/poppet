import { Context, DateTime, Effect, Layer, Redacted, Schema } from "effect";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

import {
  ConnectionError,
  Identity,
  issuer,
  requestFailure,
  resource,
  Secret,
} from "./connection.ts";

export type HttpFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

const Discovery = Schema.Struct({
  issuer: Schema.NonEmptyString,
  authorization_endpoint: Schema.NonEmptyString,
  token_endpoint: Schema.NonEmptyString,
  revocation_endpoint: Schema.NonEmptyString,
  jwks_uri: Schema.NonEmptyString,
});

const TokenReply = Schema.Struct({
  access_token: Schema.optionalKey(Secret),
  refresh_token: Schema.optionalKey(Secret),
  id_token: Schema.optionalKey(Secret),
  token_type: Schema.optionalKey(Schema.Literal("Bearer")),
  expires_in: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  scope: Schema.optionalKey(Schema.String),
});

export type TokenReply = typeof TokenReply.Type;

const Claims = Schema.Struct({
  sub: Schema.NonEmptyString,
  email: Schema.optionalKey(Schema.String),
  nonce: Schema.optionalKey(Schema.String),
});

const OAuthFailure = Schema.Struct({ error: Schema.optionalKey(Schema.String) });

interface OAuthOperations {
  readonly authorizationEndpoint: Effect.Effect<string, ConnectionError>;
  readonly exchange: (body: URLSearchParams) => Effect.Effect<TokenReply, ConnectionError>;
  readonly verifyIdentity: (
    token: Redacted.Redacted<string>,
    clientId: string,
    nonce: string | null,
  ) => Effect.Effect<Identity, ConnectionError>;
  readonly revoke: (
    refreshToken: Redacted.Redacted<string>,
    clientId: string,
  ) => Effect.Effect<void, ConnectionError>;
}

export class OAuthClient extends Context.Service<OAuthClient, OAuthOperations>()(
  "poppet/OAuthClient",
) {}

const networkError = () =>
  new ConnectionError({
    reason: "temporary",
    message: "Could not contact OpenAI. Retry later; existing credentials were retained.",
  });

const invalidIdentity = () =>
  new ConnectionError({
    reason: "identity",
    message:
      "The ChatGPT identity token could not be verified. Existing credentials were retained.",
  });

const request = (http: HttpFetch, url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: (signal) => http(url, { ...init, signal, redirect: "error" }),
    catch: networkError,
  }).pipe(
    Effect.timeout("20 seconds"),
    Effect.catchTag("TimeoutError", () => Effect.fail(networkError())),
  );

export const makeOAuthClient = (http: HttpFetch = fetch, expectedIssuer = issuer) =>
  Effect.gen(function* () {
    const discovery = yield* Effect.cached(
      Effect.gen(function* () {
        const response = yield* request(http, `${expectedIssuer}/.well-known/openid-configuration`);

        if (!response.ok) return yield* Effect.fail(requestFailure(response.status));

        const metadata = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: networkError,
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Discovery)),
          Effect.mapError(
            () =>
              new ConnectionError({
                reason: "identity",
                message: "OpenAI's identity discovery document was invalid.",
              }),
          ),
        );

        if (
          metadata.issuer !== expectedIssuer ||
          [
            metadata.authorization_endpoint,
            metadata.token_endpoint,
            metadata.revocation_endpoint,
            metadata.jwks_uri,
          ].some((url) => URL.parse(url)?.origin !== expectedIssuer)
        ) {
          return yield* Effect.fail(
            new ConnectionError({
              reason: "identity",
              message: "OpenAI's identity endpoints did not match the expected issuer.",
            }),
          );
        }

        return metadata;
      }).pipe(
        Effect.timeout("20 seconds"),
        Effect.catchTag("TimeoutError", () => Effect.fail(networkError())),
      ),
    );

    const exchange = (body: URLSearchParams) =>
      Effect.gen(function* () {
        const metadata = yield* discovery;

        const response = yield* request(http, metadata.token_endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body,
        });

        if (!response.ok) {
          const failure = yield* Effect.tryPromise({
            try: () => response.json(),
            catch: networkError,
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(OAuthFailure)),
            Effect.catch(() => Effect.succeed({ error: undefined })),
          );

          return yield* Effect.fail(
            requestFailure(
              response.status,
              failure.error ?? null,
              response.headers.get("x-request-id"),
            ),
          );
        }

        return yield* Effect.tryPromise({ try: () => response.json(), catch: networkError }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(TokenReply)),
          Effect.mapError(
            () =>
              new ConnectionError({
                reason: "identity",
                message: "OpenAI returned an invalid token response.",
              }),
          ),
        );
      }).pipe(
        Effect.timeout("20 seconds"),
        Effect.catchTag("TimeoutError", () => Effect.fail(networkError())),
      );

    const verifyIdentity = (
      token: Redacted.Redacted<string>,
      clientId: string,
      nonce: string | null,
    ) =>
      Effect.gen(function* () {
        const metadata = yield* discovery;

        const verified = yield* Effect.tryPromise({
          try: async (signal) => {
            const keys = createRemoteJWKSet(new URL(metadata.jwks_uri), {
              timeoutDuration: 10_000,
              [customFetch]: (url, options) =>
                http(url, {
                  ...options,
                  signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal,
                  redirect: "error",
                }),
            });

            return jwtVerify(Redacted.value(token), keys, {
              issuer: expectedIssuer,
              audience: clientId,
              algorithms: ["RS256"],
              requiredClaims: ["sub", "exp", "iat"],
              clockTolerance: 5,
            });
          },
          catch: invalidIdentity,
        });

        const claims = yield* Schema.decodeUnknownEffect(Claims)(verified.payload).pipe(
          Effect.mapError(invalidIdentity),
        );

        if ((verified.payload.iat ?? 0) > (yield* DateTime.nowAsDate).getTime() / 1000 + 5)
          return yield* Effect.fail(invalidIdentity());

        if (nonce !== null && claims.nonce !== nonce) return yield* Effect.fail(invalidIdentity());

        return { subject: claims.sub, email: claims.email ?? null };
      }).pipe(
        Effect.timeout("20 seconds"),
        Effect.catchTag("TimeoutError", () => Effect.fail(networkError())),
      );

    const revoke = (refreshToken: Redacted.Redacted<string>, clientId: string) =>
      Effect.gen(function* () {
        const metadata = yield* discovery;

        const response = yield* request(http, metadata.revocation_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: Redacted.value(refreshToken),
            token_type_hint: "refresh_token",
            client_id: clientId,
          }),
        });

        if (response.status !== 200) return yield* Effect.fail(requestFailure(response.status));
      });

    return {
      authorizationEndpoint: discovery.pipe(
        Effect.map((metadata) => metadata.authorization_endpoint),
      ),
      exchange,
      verifyIdentity,
      revoke,
    } satisfies OAuthOperations;
  });

export const OAuthClientLive = Layer.effect(OAuthClient, makeOAuthClient());

export const refreshBody = (token: Redacted.Redacted<string>, clientId: string) =>
  new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: Redacted.value(token),
    resource,
  });
