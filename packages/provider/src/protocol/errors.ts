import { APIError, APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "openai";

import { ProviderError, type ProviderId, type ModelRequest } from "#src/index";

/** Adapter-specific reason for a remote failure, checked first; undefined keeps the shared rules. */
export type RemoteReason = (
  status: number | undefined,
  code: string | undefined,
) => ProviderError["reason"] | undefined;

/** Adapter hooks for request headers and provider-specific inference error classification. */
export interface InferenceOptions {
  readonly failure?: (cause: unknown) => ProviderError;
  readonly classify?: RemoteReason;
  readonly headers?: (request: ModelRequest) => Record<string, string>;
}

export const safeIdentifier = (value: string | null | undefined) =>
  value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;

const sharedReason = (
  status: number | undefined,
  code: string | undefined,
): ProviderError["reason"] => {
  if (status === 401) return "authentication";

  if (status === 403) return "permission";

  if (["insufficient_quota", "usage_limit_exceeded"].includes(code ?? "")) return "quota";

  if (status === 429) return "rate-limit";

  if (code === "context_length_exceeded") return "context-limit";

  if ((status ?? 0) >= 500) return "temporary";

  return "invalid-request";
};

export const remoteFailure = (
  provider: ProviderId,
  status: number | undefined,
  rawCode: string | null | undefined,
  rawRequestId: string | null | undefined,
  classify?: RemoteReason,
) => {
  const code = safeIdentifier(rawCode);
  const reason = classify?.(status, code) ?? sharedReason(status, code);

  return new ProviderError({
    provider,
    reason,
    message: `The ${provider} request failed (${reason}). No automatic retry was attempted.`,
    status,
    code,
    requestId: safeIdentifier(rawRequestId),
  });
};

export const inferenceFailure = (
  provider: ProviderId,
  cause: unknown,
  classify?: RemoteReason,
): ProviderError => {
  if (cause instanceof ProviderError) return cause;

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
    return remoteFailure(provider, cause.status, cause.code, cause.requestID, classify);
  }

  return new ProviderError({
    provider,
    reason: "temporary",
    message: `The ${provider} request could not complete. No automatic retry was attempted.`,
  });
};
