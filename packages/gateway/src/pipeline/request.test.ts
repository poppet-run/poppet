import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { messagingRequest } from "#src/pipeline/request";

describe("messagingRequest", () => {
  test("when a fresh session selects a skill and only attaches a file, accepts the empty prompt", async () => {
    const command = "  /new --skill weekly-review  ";

    expect(await Effect.runPromise(messagingRequest(command, true))).toEqual({
      fresh: true,
      skill: "weekly-review",
      prompt: "",
    });
  });
});
