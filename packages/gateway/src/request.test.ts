import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { isControl, messagingRequest } from "#src/request";

describe("messagingRequest", () => {
  test("when a fresh session selects a skill and only attaches a file, accepts the empty prompt", async () => {
    const command = "  /new --skill weekly-review  ";

    expect(await Effect.runPromise(messagingRequest(command, true))).toEqual({
      fresh: true,
      skill: "weekly-review",
      prompt: "",
    });
    await expect(Effect.runPromise(messagingRequest(command))).rejects.toMatchObject({
      reason: "configuration",
    });
  });
});

describe("isControl", () => {
  test.each([" /status ", " /cancel ", " /approve a ", "\t/deny b\n"])(
    "when %j has surrounding whitespace, recognizes the control",
    (command) => expect(isControl(command)).toBe(true),
  );
});
