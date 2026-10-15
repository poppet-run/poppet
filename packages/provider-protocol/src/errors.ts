import { ProviderError, type ProviderId, type ModelRequest } from "@poppet/provider";
import { APIError, APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "openai";

/** Adapter hooks for request headers and provider-specific inference error classification. */
export interface InferenceOptions {
  readonly failure?: (cause: unknown) => ProviderError;
  readonly remoteFailure?: (
    status: number | undefined,
    code: string | null | undefined,
    requestId: string | null | undefined,
  ) => ProviderError;
  readonly headers?: (request: ModelRequest) => Record<string, string>;
}

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

  if (status === 401) reason = "authentication";
  else if (status === 403) reason = "permission";
  else if (["insufficient_quota", "usage_limit_exceeded"].includes(code ?? "")) reason = "quota";
  else if (status === 429) reason = "rate-limit";
  else if (code === "context_length_exceeded") reason = "context-limit";
  else if ((status ?? 0) >= 500) reason = "temporary";

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
