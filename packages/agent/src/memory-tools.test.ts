import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { decodeMemoryCall } from "#src/memory-tools";

const call = (args: string, namespace = "poppet_memory") => ({
  type: "tool-call" as const,
  name: "memory",
  namespace,
  callId: "change",
  arguments: args,
});

describe.concurrent("decodeMemoryCall", () => {
  test.each([
    "{",
    '{"action":"replace","key":"answer.style","value":null}',
    '{"action":"forget","key":"answer.style","value":"ignored"}',
    '{"action":"remember","key":"answer.style","value":" Concise"}',
    '{"action":"remember","key":"../profile.md","value":"Concise"}',
    '{"action":"remember","key":"answer.style","value":"Concise","sourceRunId":"forged"}',
    JSON.stringify({ action: "remember", key: "answer.style", value: "😀".repeat(1025) }),
  ])("when memory arguments are invalid or forged in case %#, rejects them", async (args) => {
    const result = await Effect.runPromise(decodeMemoryCall(call(args)).pipe(Effect.result));
    expect(result).toHaveProperty("failure.reason", "tool-arguments");
  });

  test("when the tool name matches in another namespace, rejects the call", async () => {
    const result = await Effect.runPromise(
      decodeMemoryCall(call('{"action":"forget","key":"answer.style","value":null}', "other")).pipe(
        Effect.result,
      ),
    );

    expect(result).toHaveProperty("failure.reason", "tool-permission");
  });
});
