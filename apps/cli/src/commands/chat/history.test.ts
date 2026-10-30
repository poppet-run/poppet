import { expect, test } from "bun:test";

import { Effect } from "effect";

import { readChatHistory } from "#src/commands/chat/history";

test("saved tool exchanges display only user and assistant text in order", async () => {
  const tool = {
    type: "tool-call",
    callId: "call",
    name: "inspect",
    namespace: null,
    arguments: "{}",
  };

  const inspection = {
    session: { id: "saved" },
    messages: [
      { message: { role: "user", text: "Inspect this" } },
      { message: { role: "assistant", output: [tool] } },
      { message: { role: "tool", callId: "call", output: "private tool output" } },
      {
        message: {
          role: "assistant",
          output: [{ type: "text", text: "First " }, tool, { type: "text", text: "answer" }],
        },
      },
      { message: { role: "user", text: "An unanswered request" } },
    ],
  };

  expect(await Effect.runPromise(readChatHistory(inspection, "saved"))).toEqual([
    { role: "user", text: "Inspect this" },
    { role: "assistant", text: "First answer" },
    { role: "user", text: "An unanswered request" },
  ]);
});

test.each([
  "{",
  { session: { id: "saved" }, messages: [{}] },
  { session: { id: "another" }, messages: [] },
])("rejects malformed or mismatched history %j", async (value) => {
  const result = await Effect.runPromise(readChatHistory(value, "saved").pipe(Effect.result));
  expect(result).toHaveProperty("failure.reason", "invalid-request");
});
