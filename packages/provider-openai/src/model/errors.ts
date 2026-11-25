import { ProviderError } from "@poppet/provider";
import type { ProviderId } from "@poppet/provider";
import { inferenceFailure as sharedInferenceFailure } from "@poppet/provider/protocol";
import type { RemoteReason } from "@poppet/provider/protocol";

import { classifyChatGPTError, ConnectionError } from "#src/connection";

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
    permission: "permission",
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

export const chatGPTReason: RemoteReason = (status, code) => {
  const classified = classifyChatGPTError(status, code);

  if (classified === "usage_limit") {
    return "quota";
  }

  if (classified === "ineligible" || classified === "permission") {
    return "permission";
  }

  if (classified === "reconnect") {
    return "authentication";
  }

  if (classified === "temporary") {
    return status === 429 ? "rate-limit" : "temporary";
  }

  if (classified === "context_limit") {
    return "context-limit";
  }

  return undefined;
};

export const inferenceFailure = (provider: ProviderId, cause: unknown): ProviderError =>
  cause instanceof ConnectionError
    ? providerFailure(cause)
    : sharedInferenceFailure(provider, cause, chatGPTReason);
