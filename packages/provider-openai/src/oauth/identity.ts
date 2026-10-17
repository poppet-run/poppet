import { DateTime, Effect, Redacted, Schema } from "effect";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

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

export const identityVerifier =
  (http: HttpFetch, expectedIssuer: string, discovery: Effect.Effect<Discovery, ConnectionError>) =>
  (token: Redacted.Redacted<string>, clientId: string, nonce: string | null) =>
    Effect.gen(function* () {
      const metadata = yield* discovery;

      const verified = yield* Effect.tryPromise({
        try: async (signal) => {
          const keys = createRemoteJWKSet(new URL(metadata.jwks_uri), {
            timeoutDuration: 10_000,
            [customFetch]: (url, options) =>
              http(url, {
                ...options,
                // Either jose's key-fetch timeout or Effect interruption can abort this request.
                signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal,
                redirect: "error",
              }),
          });

          // Verify the signature, issuer, audience, and lifetime before trusting
          // the account claims. The audience binds this token to our registration.
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

      // Initial sign-in checks the attempt's nonce. Refresh has no new browser
      // attempt, so it passes null and the auth workflow checks the saved account ID.
      if (nonce !== null && claims.nonce !== nonce) return yield* Effect.fail(invalidIdentity());

      return { subject: claims.sub, email: claims.email ?? null };
    }).pipe(
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => Effect.fail(networkError()),
      }),
    );
