import { describe, expect, test } from "bun:test";

import { requestFailure } from "#src/connection";

describe("requestFailure", () => {
  test("when remote identifiers contain unsafe text, drops them from the connection error", () => {
    expect(requestFailure(503, "bad code", "bad\u001b[31m")).toMatchObject({
      reason: "temporary",
      code: undefined,
      requestId: undefined,
    });
  });
});
