import { DateTime, Effect, Redacted, Schema } from "effect";
import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";

import { ConnectionError } from "#src/connection";
import type { Discovery } from "#src/oauth/discovery";
import { type HttpFetch, networkError } from "#src/oauth/http";

const Claims = Schema.Struct({
  sub: Schema.NonEmptyString,
  email: Schema.optionalKey(Schema.String),
  nonce: Schema.optionalKey(Schema.String),
});

const invalidIdentity = () =>
  new ConnectionError({
    reason: "identity",
    message:
      "The ChatGPT identity token could not be verified. Existing credentials were retained.",
  });

export const identityVerifier = (
  http: HttpFetch,
  expectedIssuer: string,
  discovery: Effect.Effect<Discovery, ConnectionError>,
) => {
  let cached: { uri: string; keys: ReturnType<typeof createRemoteJWKSet> } | undefined;

  const keysFor = (uri: string) => {
    if (cached?.uri !== uri) {
      cached = {
        uri,
        keys: createRemoteJWKSet(new URL(uri), {
          timeoutDuration: 10_000,
          [customFetch]: async (url, options) => {
            const response = await http(url, { ...options, redirect: "error" }).catch(() => {
              throw networkError();
            });

            if (response.status === 429 || response.status >= 500) {
              await response.body?.cancel().catch(() => {});
              throw networkError();
            }

            return response;
          },
        }),
      };
    }

    return cached.keys;
  };

  return (token: Redacted.Redacted<string>, clientId: string, nonce: string | null) =>
    Effect.gen(function* () {
      const metadata = yield* discovery;
      const currentDate = yield* DateTime.nowAsDate;

      const verified = yield* Effect.tryPromise({
        try: () =>
          jwtVerify(Redacted.value(token), keysFor(metadata.jwks_uri), {
            issuer: expectedIssuer,
            audience: clientId,
            algorithms: ["RS256"],
            requiredClaims: ["sub", "exp", "iat"],
            clockTolerance: 5,
            currentDate,
          }),
        catch: (cause) =>
          cause instanceof ConnectionError
            ? cause
            : cause instanceof errors.JWKSTimeout
              ? networkError()
              : invalidIdentity(),
      });

      const claims = yield* Schema.decodeUnknownEffect(Claims)(verified.payload).pipe(
        Effect.mapError(invalidIdentity),
      );

      const { aud, azp, iat } = verified.payload;

      if ((azp !== undefined || (Array.isArray(aud) && aud.length > 1)) && azp !== clientId)
        return yield* Effect.fail(invalidIdentity());

      if ((iat ?? 0) > currentDate.getTime() / 1000 + 5)
        return yield* Effect.fail(invalidIdentity());

      if (nonce !== null && claims.nonce !== nonce) return yield* Effect.fail(invalidIdentity());

      return { subject: claims.sub, email: claims.email ?? null };
    }).pipe(
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => Effect.fail(networkError()),
      }),
    );
};
