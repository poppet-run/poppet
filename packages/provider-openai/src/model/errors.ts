import { ProviderError, type ProviderId } from "@poppet/provider";
import { APIError, APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "openai";

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

const safeIdentifier = (value: string | null | undefined) =>
  value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;

export const remoteFailure = (
  provider: ProviderId,
  status: number | undefined,
  rawCode: string | null | undefined,
  rawRequestId: string | null | undefined,
) => {
  const code = safeIdentifier(rawCode);
  let reason: ProviderError["reason"] = "invalid-request";

  if (
    status === 401 ||
    [
      "subscription_sharing_invalid_user",
      "invalid_grant",
      "token_expired",
      "refresh_token_expired",
      "refresh_token_invalidated",
    ].includes(code ?? "")
  )
    reason = "authentication";
  else if (status === 403 || code === "subscription_sharing_user_not_eligible")
    reason = "permission";
  else if (
    [
      "subscription_sharing_usage_limit_exceeded",
      "insufficient_quota",
      "usage_limit_exceeded",
    ].includes(code ?? "")
  )
    reason = "quota";
  else if (status === 429) reason = "rate-limit";
  else if (code === "context_length_exceeded") reason = "context-limit";
  else if (
    (status ?? 0) >= 500 ||
    ["subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable"].includes(
      code ?? "",
    )
  )
    reason = "temporary";

  return new ProviderError({
    provider,
    reason,
    message: `The ${provider} request failed (${reason}). No automatic retry was attempted.`,
    status,
    code,
    requestId: safeIdentifier(rawRequestId),
  });
};

export const inferenceFailure = (provider: ProviderId, cause: unknown): ProviderError => {
  if (cause instanceof ProviderError) return cause;

  if (cause instanceof ConnectionError) return providerFailure(cause);

  if (cause instanceof APIConnectionTimeoutError || cause instanceof APIUserAbortError)
    return new ProviderError({
      provider,
      reason: "interrupted",
      message: "The inference request timed out or was interrupted.",
    });

  if (cause instanceof APIConnectionError)
    return new ProviderError({
      provider,
      reason: "temporary",
      message: `The ${provider} connection failed. No automatic retry was attempted.`,
    });

  if (cause instanceof APIError) {
    return remoteFailure(provider, cause.status, cause.code, cause.requestID);
  }

  return new ProviderError({
    provider,
    reason: "temporary",
    message: `The ${provider} request could not complete. No automatic retry was attempted.`,
  });
};
