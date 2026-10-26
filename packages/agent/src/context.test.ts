import { describe, expect, test } from "bun:test";

import type { Message, ModelDescription } from "@poppet/provider";
import type { StoredMessage } from "@poppet/store";

import { assembleContext, byteSize, contextAvailable, instructions } from "#src/context";
import { defaultPolicy } from "#src/settings";

const model: ModelDescription = {
  provider: "test-provider",
  id: "test-model",
  name: "Test",
  capabilities: {
    tools: true,
    images: false,
    generationSettings: [],
    contextWindow: null,
    maxOutputTokens: null,
  },
};

const assistant: Message = {
  role: "assistant",
  output: [{ type: "text", text: "Answer" }],
  continuation: {
    version: 1,
    provider: "test-provider",
    model: "test-model",
    data: { signature: "unchanged" },
  },
};

const incoming: Message = { role: "user", text: "Next question" };

const stored = (messages: ReadonlyArray<Message>): ReadonlyArray<StoredMessage> =>
  messages.map((message, position) => ({
    id: position + 1,
    sessionId: "session",
    runId: null,
    position,
    createdAt: 1,
    message,
  }));

const toolExchange = [
  { role: "user", text: "Read the pages" },
  {
    role: "assistant",
    output: [
      {
        type: "tool-call",
        callId: "call-1",
        name: "fetch_page",
        namespace: "poppet_web",
        arguments: '{"url":"https://example.com/"}',
      },
      {
        type: "tool-call",
        callId: "call-2",
        name: "fetch_page",
        namespace: "poppet_web",
        arguments: '{"url":"https://example.com/"}',
      },
    ],
    continuation: assistant.continuation,
  },
  { role: "tool", callId: "call-2", output: "Second page" },
  { role: "tool", callId: "call-1", output: "First page" },
  assistant,
] as const satisfies ReadonlyArray<Message>;

describe("context.ts", () => {
  test("when older images become notes, retains the surrounding exchanges within budget", () => {
    const history: Message[] = [];

    for (let turn = 0; turn < 20; turn++)
      history.push(
        {
          role: "user",
          text: `Question ${turn}`,
          attachments: Array.from({ length: 4 }, (_, index) => ({
            id: `image-${turn}-${index}`,
            name: "screen.png",
            mediaType: "image/png" as const,
            size: 100,
          })),
        },
        assistant,
      );

    const result = assembleContext(stored(history), [], [incoming], model, defaultPolicy);
    const users = result.filter((message) => message.role === "user");

    expect(result).toHaveLength(41);
    expect(users[0]?.text).toContain("Question 0\n[Earlier image not resent:");
    expect(users.flatMap((message) => message.attachments ?? []).map(({ id }) => id)).toEqual(
      [18, 19].flatMap((turn) => Array.from({ length: 4 }, (_, index) => `image-${turn}-${index}`)),
    );
    expect(result.at(-1)).toEqual(incoming);
  });

  test("when history reaches turn or byte limits, keeps complete tool exchanges and continuation together", () => {
    const history = stored([{ role: "user", text: "Old question" }, assistant, ...toolExchange]);
    expect(
      assembleContext(history, [], [incoming], model, { ...defaultPolicy, historyTurns: 1 }),
    ).toEqual([...toolExchange, incoming]);

    const contextBytes = byteSize(
      JSON.stringify({ instructions, messages: [...toolExchange, incoming], tools: [] }),
    );

    expect(
      assembleContext(history, [], [incoming], model, { ...defaultPolicy, contextBytes }),
    ).toEqual([...toolExchange, incoming]);
    expect(
      assembleContext(history, [], [incoming], model, {
        ...defaultPolicy,
        contextBytes: contextBytes - 1,
      }),
    ).toEqual([incoming]);
  });

  test("when model capacity constrains context, converts tokens to bytes and rejects oversized new messages", () => {
    // Leaves 512 bytes beyond the instructions after output and overhead tokens, at 3 bytes per token.
    const smallModel: ModelDescription = {
      ...model,
      capabilities: {
        ...model.capabilities,
        contextWindow: Math.ceil((byteSize(instructions) + 512) / 3) + 2048,
        maxOutputTokens: 1024,
      },
    };

    expect(contextAvailable(smallModel, defaultPolicy)).toBeGreaterThanOrEqual(
      byteSize(instructions) + 512,
    );
    expect(contextAvailable(smallModel, defaultPolicy)).toBeLessThan(byteSize(instructions) + 516);

    const bigOld: Message = { role: "user", text: "x".repeat(3000) };
    expect(
      assembleContext(stored([bigOld, assistant]), [], [incoming], smallModel, defaultPolicy),
    ).toEqual([incoming]);
    expect(() =>
      assembleContext(
        [],
        [],
        [{ role: "user", text: "😀".repeat(600) }],
        smallModel,
        defaultPolicy,
      ),
    ).toThrow("current exchange exceeds the context budget");
  });

  test.each([
    [toolExchange[0], toolExchange[1], toolExchange[2], assistant],
    [toolExchange[0], toolExchange[2], assistant],
    [...toolExchange.slice(0, 4), toolExchange[3], assistant],
    [toolExchange[0], assistant, toolExchange[2], assistant],
  ])("when tool history is orphaned, duplicate, or unresolved, rejects it", (...messages) => {
    expect(() => assembleContext(stored(messages), [], [incoming], model, defaultPolicy)).toThrow(
      "incomplete or invalid exchange",
    );
  });
});
