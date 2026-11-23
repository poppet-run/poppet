import { safeIdentifier } from "@poppet/provider/protocol";
import { Data, Schema } from "effect";

export const issuer = "https://auth.openai.com";

export const resource = "https://api.openai.com/v1";

export const planScope = "chatgpt.tokens.use.direct";

export const requestedScopes =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

export const Secret = Schema.RedactedFromValue(Schema.NonEmptyString);

export const Identity = Schema.Struct({
  subject: Schema.NonEmptyString,
  email: Schema.NullOr(Schema.String),
});

export const Credentials = Schema.Struct({
  accessToken: Schema.NullOr(Secret),
  refreshToken: Schema.NullOr(Secret),
  idToken: Secret,
  expiresAt: Schema.NullOr(Schema.Natural),
  scopes: Schema.Array(Schema.NonEmptyString),
});

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
  pendingRefresh: Schema.optionalKey(Credentials),
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

export class ConnectionError extends Data.TaggedError("ConnectionError")<{
  readonly reason: ConnectionFailure;
  readonly message: string;
  readonly status?: number | undefined;
  readonly code?: string | undefined;
  readonly requestId?: string | undefined;
}> {}

const authenticationCodes = new Set([
  "subscription_sharing_invalid_user",
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_invalid",
  "refresh_token_reused",
]);

const temporaryCodes = new Set([
  "subscription_sharing_usage_unavailable",
  "subscription_sharing_user_unavailable",
]);

export type ChatGPTClassification =
  | "usage_limit"
  | "ineligible"
  | "reconnect"
  | "temporary"
  | "context_limit"
  | "permission";

export const classifyChatGPTError = (
  status?: number,
  code?: string | null,
): ChatGPTClassification | null => {
  const normalized = code ?? "";

  if (normalized === "subscription_sharing_usage_limit_exceeded") {
    return "usage_limit";
  }

  if (normalized === "subscription_sharing_user_not_eligible") {
    return "ineligible";
  }

  if (status === 401 || authenticationCodes.has(normalized)) {
    return "reconnect";
  }

  if ((status !== undefined && status >= 500) || status === 429 || temporaryCodes.has(normalized)) {
    return "temporary";
  }

  if (normalized === "context_length_exceeded") {
    return "context_limit";
  }

  if (status === 403) {
    return "permission";
  }

  return null;
};

export const requestFailure = (
  status: number,
  rawCode: string | null = null,
  requestId: string | null = null,
) => {
  const code = safeIdentifier(rawCode);
  const classified = classifyChatGPTError(status, code);
  let reason: ConnectionFailure = "unsupported";

  let message =
    "OpenAI rejected the request. Check the account permissions and request configuration.";

  if (classified === "usage_limit") {
    reason = "usage_limit";
    message =
      "ChatGPT plan usage is limited. Review https://chatgpt.com/settings/usage before retrying.";
  } else if (classified === "ineligible") {
    reason = "ineligible";
    message = "ChatGPT plan usage is unavailable for this account, workspace, or policy.";
  } else if (classified === "reconnect") {
    reason = "reconnect";
    message = "The ChatGPT connection needs a new sign-in. Run poppet provider login.";
  } else if (classified === "temporary") {
    reason = "temporary";
    message = "OpenAI is temporarily unavailable. Credentials were retained; retry later.";
  } else if (classified === "context_limit") {
    reason = "context_limit";
    message = "The request exceeded the model context limit.";
  }

  return new ConnectionError({
    reason,
    message,
    status,
    code,
    requestId: safeIdentifier(requestId),
  });
};
