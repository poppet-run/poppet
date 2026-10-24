import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { decodeTaskCall } from "#src/task-tools";

const fields = {
  action: "create",
  id: null,
  name: "Summary",
  prompt: "Summarize recent conversations",
  schedule: { type: "once", at: "2026-10-18T09:00:00+01:00" },
  delivery: "local",
  skill: null,
  after: null,
  until: null,
} as const;

describe("decodeTaskCall", () => {
  test("when task controls lack required fields or mix invalid fields, rejects the arguments", async () => {
    const input = {
      type: "tool-call" as const,
      callId: "control",
      name: "manage_tasks",
      namespace: "poppet_tasks",
    };

    const empty = { ...fields, name: null, prompt: null, schedule: null, delivery: null };
    const edit = { ...empty, action: "edit", id: "job", prompt: "Updated" };
    expect(
      await Effect.runPromise(decodeTaskCall({ ...input, arguments: JSON.stringify(edit) })),
    ).toEqual({
      action: "edit",
      id: "job",
      name: null,
      prompt: "Updated",
      schedule: null,
    });

    await Promise.all(
      ["skip_next", "snooze", "run_now"].map(async (action) => {
        const control = {
          ...empty,
          action,
          id: "job",
          until: action === "snooze" ? "2099-10-22T09:00:00Z" : null,
        };

        expect(
          await Effect.runPromise(decodeTaskCall({ ...input, arguments: JSON.stringify(control) })),
        ).toMatchObject({ action, id: "job" });
      }),
    );

    await Promise.all(
      [
        { ...edit, prompt: null },
        { ...edit, skill: "other" },
        { ...edit, revision: 2 },
        { ...edit, origin: "interactive" },
        { ...empty, action: "snooze", id: "job", until: null },
        { ...empty, action: "run_now", id: null },
        { ...empty, action: "skip_next", id: "job", until: "2099-10-22T09:00:00Z" },
      ].map((invalid) =>
        expect(
          Effect.runPromise(decodeTaskCall({ ...input, arguments: JSON.stringify(invalid) })),
        ).rejects.toMatchObject({ reason: "tool-arguments" }),
      ),
    );
  });

  test("when a task includes an explicit schedule, decodes it without accepting model-supplied host authority", async () => {
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
