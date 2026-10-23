import { Data, Schema } from "effect";

export const issuer = "https://auth.openai.com";

export const resource = "https://api.openai.com/v1";

export const planScope = "chatgpt.tokens.use.direct";

export const requestedScopes =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

/** Hides tokens when printed; encoding still writes the raw token and needs protected storage. */
export const Secret = Schema.RedactedFromValue(Schema.NonEmptyString);

/** Verified account identity retained independently of token expiry. */
export const Identity = Schema.Struct({
  subject: Schema.NonEmptyString,
  email: Schema.NullOr(Schema.String),
});

/** Saved tokens and granted scopes; expiresAt is the access-token expiry in Unix milliseconds. */
export const Credentials = Schema.Struct({
  accessToken: Schema.NullOr(Secret),
  refreshToken: Schema.NullOr(Secret),
  idToken: Secret,
  expiresAt: Schema.NullOr(Schema.Natural),
  scopes: Schema.Array(Schema.NonEmptyString),
});

/** Versioned local registration, account identity, credentials, and last model verification. */
export const Connection = Schema.Struct({
  version: Schema.Literal(1),
  hostId: Schema.String.check(
    Schema.isPattern(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  ),
  clientId: Schema.NullOr(Schema.NonEmptyString),
  identity: Schema.NullOr(Identity),
  credentials: Schema.NullOr(Credentials),
  verification: Schema.NullOr(Schema.Struct({ model: Schema.NonEmptyString, at: Schema.Natural })),
});

export type Connection = typeof Connection.Type;

export type Identity = typeof Identity.Type;

export type Credentials = typeof Credentials.Type;

export type ConnectionFailure =
  | "storage"
  | "busy"
  | "callback"
  | "denied"
  | "identity"
  | "reconnect"
  | "plan_disabled"
  | "usage_limit"
  | "ineligible"
  | "temporary"
  | "unsupported"
  | "context_limit"
  | "interrupted"
  | "verification";

/** ChatGPT connection failures classified for authentication and inference recovery. */
export class ConnectionError extends Data.TaggedError("ConnectionError")<{
  readonly reason: ConnectionFailure;
  readonly message: string;
  readonly status?: number | undefined;
  readonly code?: string | undefined;
  readonly requestId?: string | undefined;
}> {}

// Translate remote status codes into reasons the auth flow can act on, such as
// retaining credentials for a temporary failure or requiring a new sign-in.
export const requestFailure = (
  status: number,
  code: string | null = null,
  requestId: string | null = null,
) => {
  let reason: ConnectionFailure = "unsupported";

  let message =
    "OpenAI rejected the request. Check the account permissions and request configuration.";

  if (code === "subscription_sharing_usage_limit_exceeded") {
    reason = "usage_limit";
    message =
      "ChatGPT plan usage is limited. Review https://chatgpt.com/settings/usage before retrying.";
  } else if (code === "subscription_sharing_user_not_eligible") {
    reason = "ineligible";
    message = "ChatGPT plan usage is unavailable for this account, workspace, or policy.";
  } else if (
    status === 401 ||
    [
      "subscription_sharing_invalid_user",
      "invalid_grant",
      "invalid_refresh_token",
      "token_expired",
      "refresh_token_expired",
      "refresh_token_invalidated",
      "refresh_token_invalid",
      "refresh_token_reused",
    ].includes(code ?? "")
  ) {
    reason = "reconnect";
    message = "The ChatGPT connection needs a new sign-in. Run poppet provider login.";
  } else if (
    status >= 500 ||
    status === 429 ||
    ["subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable"].includes(
      code ?? "",
    )
  ) {
    reason = "temporary";
    message = "OpenAI is temporarily unavailable. Credentials were retained; retry later.";
  } else if (code === "context_length_exceeded") {
    reason = "context_limit";
    message = "The request exceeded the model context limit.";
  }

  return new ConnectionError({
    reason,
    message,
    status,
    code: code ?? undefined,
    requestId: requestId ?? undefined,
  });
};
