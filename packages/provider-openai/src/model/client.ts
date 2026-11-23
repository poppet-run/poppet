import { userAgent } from "@poppet/provider";
import { openAIClient } from "@poppet/provider/protocol";
import type { Redacted } from "effect";
import { APIConnectionError, APIError, APIUserAbortError } from "openai";

import { ConnectionError, requestFailure, resource } from "#src/connection";
import type { HttpFetch } from "#src/oauth/http";

export const modelFailure = (cause: unknown): ConnectionError => {
  if (cause instanceof ConnectionError) {
    return cause;
  }

  if (cause instanceof APIUserAbortError) {
    return new ConnectionError({
      reason: "interrupted",
      message: "The OpenAI request was interrupted.",
    });
  }

  if (cause instanceof APIError && !(cause instanceof APIConnectionError)) {
    return requestFailure(cause.status ?? 0, cause.code, cause.requestID);
  }

  return new ConnectionError({
    reason: "temporary",
    message: "The OpenAI request could not complete. No automatic retry was attempted.",
  });
};

export const clientFor = (token: Redacted.Redacted<string>, http: HttpFetch) =>
  openAIClient({ key: token, baseUrl: resource, http, headers: { "User-Agent": userAgent } });
