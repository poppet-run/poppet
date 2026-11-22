import { describe, expect, test } from "bun:test";

import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "openai";

import { modelFailure } from "#src/model/client";

describe("modelFailure", () => {
  test("when the SDK reports a user abort, reports interruption", () => {
    expect(modelFailure(new APIUserAbortError()).reason).toBe("interrupted");
  });
  test.each([
    ["connection error", new APIConnectionError({ message: "reset" })],
    ["timeout", new APIConnectionTimeoutError()],
  ] as const)("when the SDK reports a %s, reports a temporary failure", (_label, error) => {
    expect(modelFailure(error).reason).toBe("temporary");
  });
});
