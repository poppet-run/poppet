import { describe, expect, test } from "bun:test";

import { Effect, Stream } from "effect";

import type { ModelRequest, Completion, ModelEvent } from "#src/schema";
import { completeModel, validateRequest, type ModelOperations } from "#src/service";

const request: ModelRequest = {
  sessionId: "test",
  workload: "assistant",
  instructions: "",
  messages: [],
  tools: [],
  settings: {},
};

const response: Completion = {
  output: [{ type: "text", text: "Fake answer" }],
  continuation: { version: 1, provider: "openai-chatgpt", model: "fake", data: {} },
  finishReason: "stop",
  usage: null,
};

const model = (events: ReadonlyArray<ModelEvent>): ModelOperations => ({
  description: {
    provider: "openai-chatgpt",
    id: "fake",
    name: "Fake model",
    capabilities: {
      tools: false,
      generationSettings: ["maxOutputTokens"],
      contextWindow: null,
      maxOutputTokens: 10,
    },
  },
  stream: () => Stream.fromIterable(events),
});

describe("shared provider contract", () => {
  test("rejects missing, duplicate, or nonterminal completion", async () => {
    const sequences = [
      [],
      [
        { type: "completed", response },
        { type: "completed", response },
      ],
      [
        { type: "completed", response },
        { type: "text-delta", text: "late" },
      ],
    ] as const;

    await Promise.all(
      sequences.map((events) =>
        expect(Effect.runPromise(completeModel(model(events), request))).rejects.toMatchObject({
          reason: "interrupted",
        }),
      ),
    );
  });

  test("closes an invalid stream before consuming more output", async () => {
    const invalid = model([
      { type: "completed", response },
      { type: "text-delta", text: "late" },
    ]);

    let closed = false;

    const inference = completeModel(
      {
        ...invalid,
        stream: (input) =>
          Stream.concat(invalid.stream(input), Stream.die("Read past invalid completion")).pipe(
            Stream.ensuring(
              Effect.sync(() => {
                closed = true;
              }),
            ),
          ),
      },
      request,
    );

    await expect(Effect.runPromise(inference)).rejects.toMatchObject({
      reason: "interrupted",
      message: "The stream has an invalid completion sequence.",
    });
    expect(closed).toBe(true);
  });

  test("validates tool capabilities, required tools, and generation bounds", async () => {
    const description = model([]).description;

    const tool = {
      name: "test",
      namespace: null,
      description: "Test tool",
      parameters: { type: "object" },
    };

    const requests = [
      { ...request, tools: [tool] },
      { ...request, settings: { toolChoice: "required" } },
      { ...request, settings: { maxOutputTokens: 11 } },
      { ...request, settings: { maxOutputTokens: -1 } },
    ] as const;

    await Promise.all(
      requests.map((invalid) =>
        expect(Effect.runPromise(validateRequest(description, invalid))).rejects.toMatchObject({
          reason: "invalid-request",
        }),
      ),
    );
  });
});
