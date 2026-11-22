import { describe, expect, test } from "bun:test";

import { Effect, Stream } from "effect";

import type { ModelDescription, ModelEvent } from "#src/index";
import { modelStream } from "#src/protocol/scoped-stream";

describe("modelStream", () => {
  test("when the transport rejects during early teardown, preserves the consumed output", async () => {
    const description: ModelDescription = {
      provider: "test-provider",
      id: "test-model",
      name: "Test model",
      capabilities: {
        tools: false,
        images: false,
        generationSettings: [],
        contextWindow: null,
        maxOutputTokens: null,
      },
    };

    const event: ModelEvent = { type: "text-delta", text: "First" };

    let aborted = false;

    const stream = modelStream(
      description,
      { sessionId: "session", instructions: "", messages: [], tools: [], settings: {} },
      (_request, signal) =>
        Effect.succeed({
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ done: false, value: event }),
            return: async () => {
              aborted = signal.aborted;
              throw new Error("Socket closed");
            },
          }),
        }),
    );

    expect(await Effect.runPromise(stream.pipe(Stream.take(1), Stream.runCollect))).toEqual([
      event,
    ]);
    expect(aborted).toBe(true);
  });
});
