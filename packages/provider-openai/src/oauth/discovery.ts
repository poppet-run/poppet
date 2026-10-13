import { Effect, Schema } from "effect";

import { ConnectionError, requestFailure } from "#src/connection";
import { type HttpFetch, networkError, request } from "#src/oauth/http";

export const Discovery = Schema.Struct({
  issuer: Schema.NonEmptyString,
  authorization_endpoint: Schema.NonEmptyString,
  token_endpoint: Schema.NonEmptyString,
  revocation_endpoint: Schema.NonEmptyString,
  jwks_uri: Schema.NonEmptyString,
});

export type Discovery = typeof Discovery.Type;

export const discoverIssuer = (http: HttpFetch, expectedIssuer: string) =>
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

    // Restrict every advertised endpoint to the expected issuer before sending
    // codes or tokens to it or fetching its signing keys.
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
  );
