import { AgentError, type ChatFailure } from "@poppet/agent";
import { StoreError } from "@poppet/store";

import { ChannelError } from "#src/channel";

/** What a failed request does next; saved state decides whether each part still applies. */
export interface FailureDecision {
  /** Delay before retrying, taken only while the request has no saved run. */
  readonly retryAfterMs: number | null;
  /** Failure reply for a request with a conversation; null fails it without a reply. */
  readonly reply: string | null;
}

const failureReply = (error: ChatFailure | ChannelError | null) => {
  if (error === null || error instanceof StoreError) return null;

  if (
    error instanceof AgentError &&
    (error.reason.startsWith("command-") || error.reason === "attachment")
  )
    return error.message;

  return "The request failed. Use /status in this conversation to inspect its session before sending a new request.";
};

/** Retries transient channel failures with backoff for up to three attempts; replies otherwise. */
export const failureDecision = (
  error: ChatFailure | ChannelError | null,
  attempts: number,
): FailureDecision => ({
  retryAfterMs:
    error instanceof ChannelError &&
    ["unavailable", "uncertain"].includes(error.reason) &&
    attempts < 3
      ? Math.max(1000 * 2 ** attempts, error.retryAfterMs ?? 0)
      : null,
  reply: failureReply(error),
});
