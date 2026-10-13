import { expect } from "bun:test";
import { createHash } from "node:crypto";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import type { Controls } from "./controls.ts";

export const makeOAuthProvider = async (controls: Controls) => {
  const keys = await generateKeyPair("RS256");
  const publicKey = { ...(await exportJWK(keys.publicKey)), kid: "test-key", alg: "RS256" };

  const authorizations: URL[] = [];
  const grants: URLSearchParams[] = [];
  let nonce = "";
  let tokenCount = 0;
  let revokedToken: string | null = null;

  const handle = async (request: Request, origin: string) => {
    const url = new URL(request.url);

    if (url.pathname === "/.well-known/openid-configuration")
      return Response.json({
        issuer: origin,
        authorization_endpoint: controls.discoveryEndpoint ?? `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        revocation_endpoint: `${origin}/revoke`,
        jwks_uri: `${origin}/jwks`,
      });

    if (url.pathname === "/jwks") return Response.json({ keys: [publicKey] });

    if (url.pathname === "/authorize") {
      authorizations.push(url);
      nonce = url.searchParams.get("nonce") ?? "";
      const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
      callback.searchParams.set(
        "state",
        controls.wrongState ? "wrong-state" : (url.searchParams.get("state") ?? ""),
      );
      callback.searchParams.set("client_id", "oaiapp_test");

      if (controls.denied) callback.searchParams.set("error", "access_denied");
      else callback.searchParams.set("code", "test-code");

      return Response.redirect(callback.toString());
    }

    if (url.pathname === "/token") {
      const body = new URLSearchParams(await request.text());
      grants.push(body);
      const refresh = body.get("grant_type") === "refresh_token";
      const error = refresh ? controls.refreshError : controls.tokenError;

      if (error !== null)
        return Response.json({ error }, { status: error === "temporary_error" ? 503 : 400 });

      if (!refresh) {
        const attempt = authorizations.at(-1);
        expect(
          createHash("sha256")
            .update(body.get("code_verifier") ?? "")
            .digest("base64url"),
        ).toBe(attempt?.searchParams.get("code_challenge") ?? "");
        expect(body.get("redirect_uri")).toBe(attempt?.searchParams.get("redirect_uri") ?? null);
      }

      tokenCount++;

      let idToken = await new SignJWT({
        sub: controls.subject,
        email: "test@example.com",
        nonce: controls.identityFailure === "nonce" ? "incorrect" : nonce,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(origin)
        .setAudience(controls.identityFailure === "audience" ? "another-client" : "oaiapp_test")
        .setIssuedAt(
          controls.identityFailure === "future" ? Math.floor(Date.now() / 1000) + 60 : undefined,
        )
        .setExpirationTime(controls.identityFailure === "expiry" ? "-1 minute" : "1 hour")
        .sign(keys.privateKey);

      if (controls.identityFailure === "signature")
        idToken = `${idToken.slice(0, idToken.lastIndexOf(".") + 1)}invalid`;

      return Response.json({
        access_token: `test-access-${tokenCount}`,
        refresh_token: `test-refresh-${tokenCount}`,
        id_token: idToken,
        token_type: "Bearer",
        expires_in: controls.expireAccess && !refresh ? 10 : 3600,
        scope: controls.scopes,
      });
    }

    if (url.pathname === "/revoke") {
      revokedToken = new URLSearchParams(await request.text()).get("token");

      return new Response(null, { status: controls.revokeFailure ? 503 : 200 });
    }

    return null;
  };

  return { handle, authorizations, grants, revoked: () => revokedToken };
};
