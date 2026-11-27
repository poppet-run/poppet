import { AgentError } from "@poppet/agent";
import type { ChatFailure } from "@poppet/agent";
import { StoreError } from "@poppet/store";
import { Match } from "effect";

import { GatewayError } from "#src/adapter";

export interface FailureDecision {
  readonly retryAfterMs: number | null;
  readonly reply: string | null;
}

const failureReply = (error: ChatFailure | GatewayError | null) => {
  if (error === null || error instanceof StoreError) {
    return null;
  }

  if (
    error instanceof AgentError &&
    (error.reason.startsWith("command-") ||
      error.reason.startsWith("mcp-") ||
      error.reason === "attachment")
  ) {
    return error.message;
  }

  return "The request failed. Use /status in this conversation to inspect its session before sending a new request.";
};

export const gatewayRetryDelay = (error: GatewayError, attempts: number) => {
  const limit = Match.value(error.reason).pipe(
    Match.when("unavailable", () => 6),
    Match.when("uncertain", () => 3),
    Match.orElse(() => 0),
  );

  return attempts < limit ? Math.max(1000 * 2 ** attempts, error.retryAfterMs ?? 0) : null;
};

export const failureDecision = (
  error: ChatFailure | GatewayError | null,
  attempts: number,
): FailureDecision => ({
  retryAfterMs: error instanceof GatewayError ? gatewayRetryDelay(error, attempts) : null,
  reply: failureReply(error),
});
