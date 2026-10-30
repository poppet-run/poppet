import { randomBytes } from "node:crypto";

import { Schema } from "effect";

const Request = Schema.Struct({
  id: Schema.optionalKey(Schema.Json),
  method: Schema.String,
  params: Schema.optionalKey(Schema.JsonObject),
});

const token = () => randomBytes(16).toString("hex");

const inputSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  additionalProperties: false,
};

export interface OAuthFixtureOptions {
  /** Metadata reports this issuer instead of the server's own address. */
  issuer?: string;
  /** Advertise non-default metadata and issuer paths only through the challenge. */
  customDiscovery?: boolean;
  /** Issue access tokens without refresh tokens. */
  noRefreshToken?: boolean;
  /** Access tokens expire at the resource server after this many tool calls. */
  tokenUses?: number;
  /** Refresh responses fail with this OAuth error code. */
  refreshError?: string;
  /** Tool calls answer 403 insufficient_scope for this scope. */
  stepUpScope?: string;
}

/**
 * An in-process MCP resource server and authorization server on loopback addresses. It
 * publishes protected resource and authorization server metadata, registers clients, issues
 * codes from `/authorize` without a browser, and rotates refresh tokens on every use.
 */
export const serveOAuth = (initial: OAuthFixtureOptions = {}) => {
  // Tests may change behavior between requests.
  const options = { ...initial };
  const events: { readonly path: string; readonly authorization: string | null }[] = [];
  const clients = new Map<string, readonly string[]>();
  const codes = new Map<string, { readonly client: string; readonly challenge: string }>();
  const access = new Map<string, number>();
  const refresh = new Set<string>();
  const registrations = { count: 0 };

  const issue = () => {
    const accessToken = `access-${token()}`;
    const refreshToken = `refresh-${token()}`;
    access.set(accessToken, 0);
    refresh.add(refreshToken);

    const issued = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "read",
    };

    return Response.json(
      options.noRefreshToken ? issued : { ...issued, refresh_token: refreshToken },
    );
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const origin = url.origin;
      const authorization = request.headers.get("authorization");
      events.push({ path: url.pathname, authorization });

      const metadataPath = options.customDiscovery
        ? "/custom-resource"
        : "/.well-known/oauth-protected-resource/mcp";

      const issuer = options.customDiscovery ? `${origin}/auth` : `${origin}/`;

      if (url.pathname === metadataPath)
        return Response.json({ resource: `${origin}/mcp`, authorization_servers: [issuer] });

      if (
        url.pathname ===
        (options.customDiscovery
          ? "/.well-known/oauth-authorization-server/auth"
          : "/.well-known/oauth-authorization-server")
      )
        return Response.json({
          issuer: options.issuer ?? issuer,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}${options.customDiscovery ? "/custom-register" : "/register"}`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code", "refresh_token"],
        });

      if (url.pathname === (options.customDiscovery ? "/custom-register" : "/register")) {
        const metadata = Schema.decodeUnknownSync(
          Schema.Struct({ redirect_uris: Schema.Array(Schema.String) }),
        )(await request.json());

        const id = `client-${++registrations.count}`;
        clients.set(id, metadata.redirect_uris);

        return Response.json(
          { client_id: id, redirect_uris: metadata.redirect_uris },
          { status: 201 },
        );
      }

      if (url.pathname === "/authorize") {
        const client = url.searchParams.get("client_id") ?? "";
        const redirect = url.searchParams.get("redirect_uri") ?? "";

        if (!clients.get(client)?.includes(redirect))
          return new Response("Unknown client or redirect URI", { status: 400 });
        const code = `code-${token()}`;
        codes.set(code, { client, challenge: url.searchParams.get("code_challenge") ?? "" });
        const target = new URL(redirect);
        target.searchParams.set("code", code);
        target.searchParams.set("state", url.searchParams.get("state") ?? "");

        return new Response(null, { status: 302, headers: { location: target.href } });
      }

      if (url.pathname === "/token") {
        const body = new URLSearchParams(await request.text());

        if (body.get("grant_type") === "authorization_code") {
          const code = body.get("code") ?? "";
          const saved = codes.get(code);
          codes.delete(code);

          const digest = new Bun.CryptoHasher("sha256")
            .update(body.get("code_verifier") ?? "")
            .digest("base64url");

          if (saved === undefined || saved.challenge !== digest)
            return Response.json({ error: "invalid_grant" }, { status: 400 });

          return issue();
        }

        const presented = body.get("refresh_token") ?? "";

        if (options.refreshError !== undefined)
          return Response.json({ error: options.refreshError }, { status: 400 });

        if (!refresh.delete(presented))
          return Response.json({ error: "invalid_grant" }, { status: 400 });

        return issue();
      }

      if (url.pathname !== "/mcp") return new Response(null, { status: 404 });
      const bearer = authorization?.replace(/^Bearer /, "") ?? "";
      const uses = access.get(bearer);

      if (uses === undefined || uses >= (options.tokenUses ?? Number.POSITIVE_INFINITY))
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}${metadataPath}"`,
          },
        });

      if (request.method !== "POST")
        return new Response(null, { status: request.method === "DELETE" ? 200 : 405 });

      const message = Schema.decodeUnknownSync(Schema.fromJsonString(Request))(
        await request.text(),
      );

      if (message.id === undefined) return new Response(null, { status: 202 });

      const reply = (result: Schema.JsonObject) =>
        Response.json(
          { jsonrpc: "2.0", id: message.id!, result },
          { headers: { "mcp-session-id": "session" } },
        );

      if (message.method === "initialize")
        return reply({
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "oauth-fixture", version: "1" },
        });

      if (message.method === "tools/list")
        return reply({ tools: [{ name: "read", description: "Fixture tool", inputSchema }] });

      if (options.stepUpScope !== undefined)
        return new Response(null, {
          status: 403,
          headers: {
            "www-authenticate": `Bearer error="insufficient_scope", scope="${options.stepUpScope}"`,
          },
        });

      access.set(bearer, uses + 1);

      return reply({ content: [{ type: "text", text: `token ${bearer}` }] });
    },
  });

  return {
    options,
    events,
    registrations,
    url: `http://127.0.0.1:${server.port}/mcp`,
    /** Follows the authorization redirect the way a consenting browser would. */
    approve: async (authorizationURL: URL) => {
      const response = await fetch(authorizationURL, { redirect: "manual" });

      return new URL(response.headers.get("location") ?? "");
    },
    stop: () => server.stop(true),
  };
};
