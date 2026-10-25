import { describe, expect, test } from "bun:test";

import { APIConnectionError, APIError, APIUserAbortError } from "openai";

import { routerFailure } from "#src/protocol";

describe("routerFailure", () => {
  test("when the connection drops or is aborted, reports it as temporary or interrupted", () => {
    expect(routerFailure(new APIConnectionError({ message: "reset" })).reason).toBe("temporary");
    expect(routerFailure(new APIUserAbortError()).reason).toBe("interrupted");
  });

  test("when OpenRouter reports payment or upstream failures, classifies them before status rules", () => {
    expect(routerFailure(new APIError(402, undefined, undefined, new Headers())).reason).toBe(
      "quota",
    );
    expect(
      routerFailure(new APIError(401, { code: "provider_error" }, "", new Headers())).reason,
    ).toBe("temporary");
  });
});
