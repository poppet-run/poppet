import { Effect, type Schema } from "effect";
import { describe, expect, test } from "vitest";

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

const decode = (args: Schema.JsonObject) =>
  Effect.runPromise(
    decodeTaskCall({
      type: "tool-call",
      callId: "task",
      name: "manage_tasks",
      namespace: "poppet_tasks",
      arguments: JSON.stringify(args),
    }),
  );

describe("decodeTaskCall", () => {
  test("when an action receives fields it does not use, ignores them", async () => {
    const until = "2099-10-22T09:00:00Z";
    const stray = { ...fields, id: "job", after: "cursor", until, skill: "review" };

    expect(await decode({ ...stray, action: "list" })).toEqual({ action: "list", after: "cursor" });
    expect(await decode({ ...stray, action: "pause" })).toEqual({ action: "pause", id: "job" });
    expect(await decode({ ...stray, action: "run_now" })).toEqual({ action: "run_now", id: "job" });
    expect(await decode({ ...stray, action: "snooze" })).toEqual({
      action: "snooze",
      id: "job",
      until,
    });
    expect(await decode({ ...stray, action: "edit", name: null, schedule: null })).toEqual({
      action: "edit",
      id: "job",
      name: null,
      prompt: fields.prompt,
      schedule: null,
    });
    expect(await decode(stray)).toEqual({
      action: "create",
      name: fields.name,
      prompt: fields.prompt,
      schedule: fields.schedule,
      delivery: "local",
      skill: "review",
    });
  });

  test("when a task selects another channel, decodes its destination", async () => {
    expect(await decode({ ...fields, delivery: { conversationId: "123456789" } })).toMatchObject({
      action: "create",
      delivery: { conversationId: "123456789" },
    });
  });

  test.each([
    [{ ...fields, name: null, schedule: null }, "The create action needs name, schedule."],
    [{ ...fields, delivery: null }, "The create action needs delivery."],
    [{ ...fields, action: "show" }, "The show action needs id."],
    [{ ...fields, action: "snooze", id: "job" }, "The snooze action needs until."],
    [
      { ...fields, action: "edit", id: "job", name: null, prompt: null, schedule: null },
      "The edit action needs at least one of name, prompt, or schedule.",
    ],
  ])("when a required field is missing in case %#, names it", async (args, message) => {
    await expect(decode(args)).rejects.toMatchObject({ reason: "tool-arguments", message });
  });

  test("when arguments add host authority or break the schema, rejects them", async () => {
    await Promise.all(
      [
        { ...fields, provider: "other-provider" },
        { ...fields, origin: "interactive" },
        { ...fields, conversationId: "other-thread" },
        { ...fields, revision: 2 },
        { ...fields, delivery: { conversationId: "" } },
        { ...fields, delivery: { conversationId: "x".repeat(129) } },
        { ...fields, delivery: { conversationId: "other-thread", ownerId: "other-owner" } },
        { ...fields, delivery: { conversationId: "other-thread", adapter: "other-gateway" } },
        { ...fields, prompt: "🙂".repeat(4097) },
        { ...fields, action: "clear" },
      ].map((args) => expect(decode(args)).rejects.toMatchObject({ reason: "tool-arguments" })),
    );
  });
});
