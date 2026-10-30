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

  const json = JSON.stringify({
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
  });

  expect(await Effect.runPromise(readChatHistory(json, "saved"))).toEqual([
    { role: "user", text: "Inspect this" },
    { role: "assistant", text: "First answer" },
    { role: "user", text: "An unanswered request" },
  ]);
});

test.each([
  "{",
  JSON.stringify({ session: { id: "saved" }, messages: [{}] }),
  JSON.stringify({ session: { id: "another" }, messages: [] }),
])("rejects malformed or mismatched history %s", async (json) => {
  const result = await Effect.runPromise(readChatHistory(json, "saved").pipe(Effect.result));
  expect(result).toHaveProperty("failure.reason", "invalid-request");
});
