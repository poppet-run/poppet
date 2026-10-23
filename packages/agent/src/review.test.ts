import { describe, expect, test } from "bun:test";

import type { StoredMessage, ToolCall } from "@poppet/store";

import { reviewDecision, reviewTranscript } from "#src/review";

const policy = { reviewMinToolCalls: 3, reviewTurnInterval: 5 };

const call = (name: string, serverId: string | null = null) => ({ name, serverId });

describe("review.ts", () => {
  test.each([
    [[call("view_skill")], 0, false, null],
    [[call("view_skill"), call("view_skill"), call("manage_skill")], 0, false, "pending"],
    [[], 5, false, "pending"],
    [[call("fetch_page"), call("view_skill"), call("view_skill")], 0, false, "skipped"],
    [[call("tool", "server"), call("view_skill"), call("view_skill")], 0, false, "skipped"],
    [[call("search_sessions"), call("view_skill"), call("view_skill")], 0, false, "skipped"],
    [[], 5, true, "skipped"],
  ] as const)(
    "when calls are %j after %i runs with attachment %s, returns %s",
    (calls, runs, attachment, state) => {
      expect(reviewDecision(calls, runs, attachment, policy)?.state ?? null).toBe(state);
    },
  );

  test("when the transcript exceeds its byte budget, shrinks tool content or returns null", () => {
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
        name: "view_skill",
        namespace: "poppet_skills",
        arguments: '{"name":"acorn"}',
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
      tools: [{ tool: "poppet_skills.view_skill", status: "completed" }],
    });
    expect(Buffer.byteLength(full)).toBeLessThan(4096);
    expect(Buffer.byteLength(reviewTranscript(messages, calls, 1024)!)).toBeLessThanOrEqual(1024);
    expect(reviewTranscript(messages, calls, 50)).toBeNull();
  });
});
