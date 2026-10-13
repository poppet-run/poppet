import { Context, Effect, Layer, Redacted, Schema } from "effect";

import { ConnectionError, type Identity, issuer, requestFailure } from "../connection.ts";
import { discoverIssuer } from "./discovery.ts";
import { type HttpFetch, networkError, request } from "./http.ts";
import { identityVerifier } from "./identity.ts";
import { TokenReply } from "./tokens.ts";

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

export const makeOAuthClient = (http: HttpFetch = fetch, expectedIssuer = issuer) =>
  Effect.gen(function* () {
    // Cache discovery within this client. The request stays lazy and runs when
    // an operation first needs metadata, then shares the validated result.
    const discovery = yield* Effect.cached(discoverIssuer(http, expectedIssuer));
    const verifyIdentity = identityVerifier(http, expectedIssuer, discovery);

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
