import { DateTime, Effect, Redacted, Schema } from "effect";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

import { ConnectionError } from "../connection.ts";
import type { Discovery } from "./discovery.ts";
import { type HttpFetch, networkError } from "./http.ts";

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
