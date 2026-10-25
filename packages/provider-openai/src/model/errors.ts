import { ProviderError, type ProviderId } from "@poppet/provider";
import {
  inferenceFailure as sharedInferenceFailure,
  type RemoteReason,
} from "@poppet/provider/protocol";

import { ConnectionError } from "#src/connection";

export const providerFailure = (error: ConnectionError) => {
  const reasons = {
    storage: "authentication",
    busy: "authentication",
    callback: "authentication",
    denied: "permission",
    identity: "authentication",
    reconnect: "authentication",
    plan_disabled: "permission",
    usage_limit: "quota",
    ineligible: "permission",
    temporary: "temporary",
    unsupported: "invalid-request",
    context_limit: "context-limit",
    interrupted: "interrupted",
    verification: "invalid-request",
  } satisfies Record<ConnectionError["reason"], ProviderError["reason"]>;

  return new ProviderError({
    provider: "openai-chatgpt",
    reason: reasons[error.reason],
    message: error.message,
    status: error.status,
    code: error.code,
    requestId: error.requestId,
  });
};

export const connectionFailure = (error: ProviderError) => {
  const reasons = {
    authentication: "reconnect",
    permission: "plan_disabled",
    quota: "usage_limit",
    "rate-limit": "temporary",
    temporary: "temporary",
    "invalid-request": "verification",
    "context-limit": "context_limit",
    interrupted: "interrupted",
  } satisfies Record<ProviderError["reason"], ConnectionError["reason"]>;

  return new ConnectionError({
    reason: reasons[error.reason],
    message: error.message,
    status: error.status,
    code: error.code,
    requestId: error.requestId,
  });
};

const authenticationCodes = new Set([
  "subscription_sharing_invalid_user",
  "invalid_grant",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
]);

const temporaryCodes = new Set([
  "subscription_sharing_usage_unavailable",
  "subscription_sharing_user_unavailable",
]);

/** ChatGPT subscription codes, checked at the same precedence as the shared status rules. */
export const chatGPTReason: RemoteReason = (status, code = "") => {
  if (status === 401 || authenticationCodes.has(code)) return "authentication";

  if (status === 403 || code === "subscription_sharing_user_not_eligible") return "permission";

  if (code === "subscription_sharing_usage_limit_exceeded") return "quota";

  // A rate limit outranks an unavailable subscription, as it does in the shared rules.
  if (temporaryCodes.has(code) && status !== 429) return "temporary";

  return undefined;
};

export const inferenceFailure = (provider: ProviderId, cause: unknown): ProviderError =>
  cause instanceof ConnectionError
    ? providerFailure(cause)
    : sharedInferenceFailure(provider, cause, chatGPTReason);
