import { openAIClient } from "@poppet/provider-protocol";
import { Redacted } from "effect";
import { APIError } from "openai";

import { ConnectionError, requestFailure, resource } from "#src/connection";
import type { HttpFetch } from "#src/oauth/http";

export const modelFailure = (cause: unknown): ConnectionError => {
  if (cause instanceof ConnectionError) return cause;

  if (cause instanceof APIError)
    return requestFailure(cause.status ?? 0, cause.code, cause.requestID);

  return new ConnectionError({
    reason: "temporary",
    message: "The OpenAI request could not complete. No automatic retry was attempted.",
  });
};

// The SDK puts this OAuth access token in the bearer header through its apiKey
// option. Disable retries so one verification attempt cannot silently repeat inference.
export const clientFor = (token: Redacted.Redacted<string>, http: HttpFetch) =>
  openAIClient({ key: token, baseUrl: resource, http });
