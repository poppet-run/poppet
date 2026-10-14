import { type Connection, ConnectionError, type Credentials, planScope } from "#src/connection";
import type { TokenReply } from "#src/oauth/tokens";

export interface ConnectionStatus {
  readonly connected: boolean;
  readonly email: string | null;
  readonly clientId: string | null;
  readonly planUsage: boolean;
  readonly expiresAt: number | null;
  readonly verification: Connection["verification"];
}

export const reconnect = () =>
  new ConnectionError({
    reason: "reconnect",
    message: "Sign in first with bun run start auth login.",
  });

// Expose connection metadata to the CLI without including any tokens.
export const statusFor = (connection: Connection | null): ConnectionStatus => ({
  connected: connection !== null && connection.identity !== null && connection.credentials !== null,
  email: connection?.identity?.email ?? null,
  clientId: connection?.clientId ?? null,
  planUsage: connection?.credentials?.scopes.includes(planScope) ?? false,
  expiresAt: connection?.credentials?.expiresAt ?? null,
  verification: connection?.verification ?? null,
});

// Refresh replies can omit an unchanged ID token, refresh token, or scope.
// Keep those fields; a missing access token or expiry stays empty.
export const credentialsFor = (
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
