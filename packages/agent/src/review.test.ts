import { describe, expect, test } from "bun:test";

import type { StoredMessage, ToolCall } from "@poppet/store";

import { reviewDecision, reviewTranscript } from "#src/review";

const policy = { reviewMinToolCalls: 3, reviewTurnInterval: 5 };

const call = (name: string, serverId: string | null = null) => ({ name, serverId });

describe("background review", () => {
  test.each([
    [[call("read_note")], 0, false, null],
    [[call("read_note"), call("read_note"), call("save_note")], 0, false, "pending"],
    [[], 5, false, "pending"],
    [[call("fetch_page"), call("read_note"), call("read_note")], 0, false, "skipped"],
    [[call("tool", "server"), call("read_note"), call("read_note")], 0, false, "skipped"],
    [[call("search_sessions"), call("read_note"), call("read_note")], 0, false, "skipped"],
    [[], 5, true, "skipped"],
  ] as const)(
    "decides %j after %i runs (attachment %s) as %s",
    (calls, runs, attachment, state) => {
      expect(reviewDecision(calls, runs, attachment, policy)?.state ?? null).toBe(state);
    },
  );

  test("bounds the transcript by shrinking tool content before giving up", () => {
    const messages: StoredMessage[] = [
      {
        id: 1,
        sessionId: "s",
        runId: "r",
        position: 0,
        createdAt: 0,
        message: { role: "user", text: "Summarize Acorn" },
      },
      {
        id: 2,
        sessionId: "s",
        runId: "r",
        position: 1,
        createdAt: 0,
        message: {
          role: "assistant",
          output: [{ type: "text", text: "Summary" }],
          continuation: { version: 1, provider: "p", model: "m", data: {} },
        },
      },
    ];

    const calls = [
      {
        runId: "r",
        callId: "c",
        position: 0,
        name: "read_note",
        namespace: "poppet_notes",
        arguments: '{"path":"acorn.md"}',
        serverId: null,
        toolName: null,
        status: "completed",
        createdAt: 0,
        startedAt: 0,
        finishedAt: 0,
        output: "x".repeat(10_000),
        failureReason: null,
      },
    ] satisfies ToolCall[];

    const full = reviewTranscript(messages, calls, 65536)!;
    expect(JSON.parse(full)).toMatchObject({
      requests: ["Summarize Acorn"],
      answer: "Summary",
      tools: [{ tool: "poppet_notes.read_note", status: "completed" }],
    });
    expect(Buffer.byteLength(full)).toBeLessThan(4096);
    expect(Buffer.byteLength(reviewTranscript(messages, calls, 1024)!)).toBeLessThanOrEqual(1024);
    expect(reviewTranscript(messages, calls, 50)).toBeNull();
  });
});
