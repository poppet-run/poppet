import { describe, expect, test } from "bun:test";

import type { Message, ModelDescription } from "@poppet/provider";
import type { StoredMessage } from "@poppet/store";

import { assembleContext, byteSize, instructions } from "#src/context";
import { defaultPolicy } from "#src/settings";

const model: ModelDescription = {
  provider: "test-provider",
  id: "test-model",
  name: "Test",
  capabilities: { tools: true, generationSettings: [], contextWindow: null, maxOutputTokens: null },
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
  { role: "user", text: "Find a note" },
  {
    role: "assistant",
    output: [
      {
        type: "tool-call",
        callId: "call-1",
        name: "read_note",
        namespace: "notes",
        arguments: "{}",
      },
      {
        type: "tool-call",
        callId: "call-2",
        name: "read_note",
        namespace: "notes",
        arguments: "{}",
      },
    ],
    continuation: assistant.continuation,
  },
  { role: "tool", callId: "call-2", output: "Second note" },
  { role: "tool", callId: "call-1", output: "First note" },
  assistant,
] as const satisfies ReadonlyArray<Message>;

describe("chat context", () => {
  test("keeps complete tool exchanges and continuation together under turn and byte limits", () => {
    const history = stored([{ role: "user", text: "Old question" }, assistant, ...toolExchange]);
    expect(
      assembleContext(history, [], incoming, model, { ...defaultPolicy, historyTurns: 1 }),
    ).toEqual([...toolExchange, incoming]);

    const contextBytes = byteSize(
      JSON.stringify({ instructions, messages: [...toolExchange, incoming], tools: [] }),
    );

    expect(
      assembleContext(history, [], incoming, model, { ...defaultPolicy, contextBytes }),
    ).toEqual([...toolExchange, incoming]);
    expect(
      assembleContext(history, [], incoming, model, {
        ...defaultPolicy,
        contextBytes: contextBytes - 1,
      }),
    ).toEqual([incoming]);
  });

  test("uses model capacity and UTF-8 bytes and never drops an oversized new message silently", () => {
    const smallModel: ModelDescription = {
      ...model,
      capabilities: { ...model.capabilities, contextWindow: 4096, maxOutputTokens: 1024 },
    };

    const bigOld: Message = { role: "user", text: "x".repeat(3000) };
    expect(
      assembleContext(stored([bigOld, assistant]), [], incoming, smallModel, defaultPolicy),
    ).toEqual([incoming]);
    expect(() =>
      assembleContext([], [], { role: "user", text: "😀".repeat(600) }, smallModel, defaultPolicy),
    ).toThrow("new message exceeds the context budget");
  });

  test.each([
    [toolExchange[0], toolExchange[1], toolExchange[2], assistant],
    [toolExchange[0], toolExchange[2], assistant],
    [...toolExchange.slice(0, 4), toolExchange[3], assistant],
    [toolExchange[0], assistant, toolExchange[2], assistant],
  ])("rejects orphaned, duplicate or unresolved tool history", (...messages) => {
    expect(() => assembleContext(stored(messages), [], incoming, model, defaultPolicy)).toThrow(
      "incomplete or invalid exchange",
    );
  });
});
