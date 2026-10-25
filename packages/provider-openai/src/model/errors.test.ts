import { APIConnectionError, APIError } from "openai";
import { describe, expect, test } from "vitest";

import { inferenceFailure } from "#src/model/errors";

const failure = (status: number, code: string) =>
  inferenceFailure("openai-chatgpt", new APIError(status, { code }, "", new Headers())).reason;

describe("inferenceFailure", () => {
  test("when the connection drops, reports a temporary failure rather than an invalid request", () => {
    expect(
      inferenceFailure("openai-chatgpt", new APIConnectionError({ message: "reset" })),
    ).toMatchObject({ reason: "temporary" });
  });

  test("when ChatGPT reports subscription codes, maps them to the matching reason", () => {
    expect(failure(400, "token_expired")).toBe("authentication");
    expect(failure(400, "subscription_sharing_usage_limit_exceeded")).toBe("quota");
    expect(failure(400, "subscription_sharing_user_unavailable")).toBe("temporary");
    expect(failure(429, "subscription_sharing_user_unavailable")).toBe("rate-limit");
  });
});
