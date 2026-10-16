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

describe.concurrent("memory tool arguments", () => {
  test("decodes explicit changes and requires null for forgetting", async () => {
    expect(
      await Effect.runPromise(
        decodeMemoryCall(call('{"action":"remember","key":"answer.style","value":"Concise"}')),
      ),
    ).toEqual({ name: "memory", action: "remember", key: "answer.style", value: "Concise" });
    expect(
      await Effect.runPromise(
        decodeMemoryCall(call('{"action":"forget","key":"answer.style","value":null}')),
      ),
    ).toEqual({ name: "memory", action: "forget", key: "answer.style" });
    expect(
      await Effect.runPromise(
        decodeMemoryCall(call('{"action":"replace","key":"answer.style","value":"Detailed"}')),
      ),
    ).toHaveProperty("action", "replace");
  });

  test.each([
    "{",
    '{"action":"replace","key":"answer.style","value":null}',
    '{"action":"forget","key":"answer.style","value":"ignored"}',
    '{"action":"remember","key":"answer.style","value":" Concise"}',
    '{"action":"remember","key":"../profile.md","value":"Concise"}',
    '{"action":"remember","key":"answer.style","value":"Concise","sourceRunId":"forged"}',
    JSON.stringify({ action: "remember", key: "answer.style", value: "😀".repeat(1025) }),
  ])("rejects invalid or forged memory arguments %#", async (args) => {
    const result = await Effect.runPromise(decodeMemoryCall(call(args)).pipe(Effect.result));
    expect(result).toHaveProperty("failure.reason", "tool-arguments");
  });

  test("rejects a matching name in another namespace", async () => {
    const result = await Effect.runPromise(
      decodeMemoryCall(call('{"action":"forget","key":"answer.style","value":null}', "other")).pipe(
        Effect.result,
      ),
    );

    expect(result).toHaveProperty("failure.reason", "tool-permission");
  });
});
