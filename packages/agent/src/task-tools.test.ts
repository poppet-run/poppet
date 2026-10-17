import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { decodeTaskCall } from "#src/task-tools";

const fields = {
  action: "create",
  id: null,
  name: "Summary",
  prompt: "Summarize my notes",
  schedule: { type: "once", at: "2026-10-18T09:00:00+01:00" },
  delivery: "local",
  skill: null,
  after: null,
} as const;

describe("chat task arguments", () => {
  test("decodes an explicit schedule without accepting host authority from the model", async () => {
    const input = {
      type: "tool-call" as const,
      callId: "task",
      name: "manage_tasks",
      namespace: "poppet_tasks",
      arguments: JSON.stringify(fields),
    };

    expect(await Effect.runPromise(decodeTaskCall(input))).toEqual({
      action: "create",
      name: fields.name,
      prompt: fields.prompt,
      schedule: fields.schedule,
      delivery: "local",
      skill: null,
    });
    await Promise.all(
      [
        { ...fields, provider: "other-provider" },
        { ...fields, origin: "interactive" },
        { ...fields, conversationId: "other-thread" },
        { ...fields, id: "unrelated" },
        { ...fields, prompt: "🙂".repeat(4097) },
        { ...fields, action: "clear" },
        { ...fields, action: "list" },
      ].map((args) =>
        expect(
          Effect.runPromise(decodeTaskCall({ ...input, arguments: JSON.stringify(args) })),
        ).rejects.toMatchObject({ reason: "tool-arguments" }),
      ),
    );
  });
});
