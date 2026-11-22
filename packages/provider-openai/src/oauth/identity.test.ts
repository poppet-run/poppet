import { describe, expect, test } from "bun:test";

import { Effect, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { identityVerifier } from "#src/oauth/identity";

const issuer = "https://oauth.invalid";
const client = "test-client";
const audiences = [client, "other"];
const now = 1_600_000_000;
const keys = generateKeyPair("RS256");

describe("identityVerifier", () => {
  test.each([
    {
      name: "multiple audiences and no authorized party",
      aud: audiences,
      valid: false,
    },
    {
      name: "multiple audiences and a matching authorized party",
      aud: audiences,
      azp: client,
      valid: true,
    },
    {
      name: "one audience and a foreign authorized party",
      aud: client,
      azp: "other",
      valid: false,
    },
  ])("when the token has $name, reports validity as $valid", async (example) => {
    const { publicKey, privateKey } = await keys;
    const jwk = await exportJWK(publicKey);

    const token = await new SignJWT(example.azp === undefined ? {} : { azp: example.azp })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(issuer)
      .setAudience(example.aud)
      .setSubject("test-user")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(privateKey);

    const verify = identityVerifier(
      async () => Response.json({ keys: [jwk] }),
      issuer,
      Effect.succeed({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        revocation_endpoint: `${issuer}/revoke`,
        jwks_uri: `${issuer}/keys`,
      }),
    );

    const result = await Effect.runPromise(
      TestClock.setTime(now * 1000).pipe(
        Effect.andThen(verify(Redacted.make(token), client, null)),
        Effect.result,
        Effect.provide(TestClock.layer()),
      ),
    );

    expect(result).toMatchObject(
      example.valid ? { success: { subject: "test-user" } } : { failure: { reason: "identity" } },
    );
  });
});
