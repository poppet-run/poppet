import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentError,
  ChatSettings,
  ChatTasks,
  SkillsLive,
  defaultPolicy,
  type ChatTaskAction,
  type ChatTaskContext,
} from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { Store, StoreDatabase, StoreLive, type Run } from "@poppet/store";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";

import { ChatTasksLive } from "#src/chat-tools";
import { TaskRepository, TaskRepositoryLive } from "#src/task-store";

const now = Date.parse("2026-10-17T10:00:00Z");

const create: ChatTaskAction = {
  action: "create",
  name: "Summary",
  prompt: "Summarize the notes",
  schedule: { type: "once", at: "2026-10-18T09:00:00+01:00" },
  delivery: "local",
  skill: null,
};

const fixture = async (toolBytes = 16384) => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-chat-tasks-"));

  const config = Layer.succeed(AppConfig, {
    applicationName: "Test",
    dataDirectory: directory,
    notesDirectory: join(directory, "notes"),
    provider: "test-provider",
    model: "test-model",
  });

  const store = StoreLive.pipe(Layer.provideMerge(config));
  const tasks = TaskRepositoryLive.pipe(Layer.provideMerge(store));

  const layer = ChatTasksLive.pipe(
    Layer.provideMerge([
      tasks,
      SkillsLive.pipe(Layer.provide(config)),
      Layer.succeed(ChatSettings, { ...defaultPolicy, toolBytes }),
    ]),
  );

  return {
    directory,
    run: <A, E>(program: Effect.Effect<A, E, ChatTasks | Store | StoreDatabase | TaskRepository>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(now);

          return yield* program;
        }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
      ),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

const recorded = (action: ChatTaskAction, callId = "task", run?: Run) =>
  Effect.gen(function* () {
    const store = yield* Store;

    const active =
      run ??
      (yield* Effect.gen(function* () {
        const session = yield* store.createSession("test-provider", "test-model", {
          workload: "coding",
        });

        const queued = yield* store.queueRun(session.id, [
          { role: "user", text: "Manage this task" },
        ]);

        return yield* store.startRun(queued.id);
      }));

    yield* store.recordToolCalls(active.id, {
      output: [
        {
          type: "tool-call",
          callId,
          name: "manage_tasks",
          namespace: "poppet_tasks",
          arguments: JSON.stringify(action),
        },
      ],
      finishReason: "tool-calls",
      usage: null,
      continuation: { version: 1, provider: active.provider, model: active.model, data: {} },
    });

    const context: ChatTaskContext = {
      origin: "interactive",
      runId: active.id,
      callId,
      here: null,
    };

    return { store, run: active, context };
  });

const execute = (action: ChatTaskAction, context: ChatTaskContext) =>
  Effect.gen(function* () {
    const planned = yield* (yield* ChatTasks).prepare(action, context);
    yield* (yield* Store).startToolCall(context.runId, context.callId);

    return yield* planned.execute;
  });

describe("chat task operations", () => {
  test("commits a selected skill and receipt, retains them after failed inference and restart, and deduplicates acknowledgement loss", async () => {
    const state = await fixture();
    await mkdir(join(state.directory, "skills/weekly"), { recursive: true });
    await writeFile(join(state.directory, "skills/weekly/SKILL.md"), "Original procedure");
    const action: ChatTaskAction = { ...create, skill: "weekly" };

    try {
      const saved = await state.run(
        Effect.gen(function* () {
          const { store, run, context } = yield* recorded(action);
          const receipt = yield* execute(action, context);
          const task = (yield* TaskRepository).list()[0]!;
          expect(task).toMatchObject({
            provider: "test-provider",
            model: "test-model",
            workload: "coding",
            skill: { name: "weekly", content: "Original procedure" },
            schedule: { type: "once", at: Date.parse("2026-10-18T08:00:00Z") },
          });
          expect((yield* store.toolCalls(run.id))[0]).toMatchObject({
            status: "completed",
            output: receipt,
          });
          yield* store.finishRun(run.id, { status: "failed", reason: "provider:temporary" });

          return { context, receipt };
        }),
      );

      await rm(join(state.directory, "skills"), { recursive: true });
      await state.run(
        Effect.gen(function* () {
          const planned = yield* (yield* ChatTasks).prepare(action, saved.context);
          expect(yield* planned.execute).toBe(saved.receipt);
          expect((yield* TaskRepository).list()).toHaveLength(1);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("rolls back the task if writing its tool receipt fails", async () => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const { context, store } = yield* recorded(create);
          const { database } = yield* StoreDatabase;
          database.run(
            `CREATE TRIGGER reject_task_receipt BEFORE INSERT ON messages WHEN json_extract(NEW.payload, '$.role') = 'tool' BEGIN SELECT RAISE(ABORT, 'receipt failed'); END`,
          );
          expect(yield* execute(create, context).pipe(Effect.flip)).toMatchObject({
            reason: "storage",
          });
          expect((yield* TaskRepository).list()).toEqual([]);
          expect((yield* store.toolCalls(context.runId))[0]).toMatchObject({
            status: "running",
            output: null,
          });
          database.run("DROP TRIGGER reject_task_receipt");
        }),
      );
    } finally {
      await state.close();
    }
  });

  test.each([
    { ...create, schedule: { type: "once" as const, at: "2026-10-17T09:00:00Z" } },
    { ...create, schedule: { type: "once" as const, at: "tomorrow" } },
    { ...create, schedule: { type: "cron" as const, expression: "0 9 * *", timezone: "UTC" } },
    {
      ...create,
      schedule: { type: "cron" as const, expression: "0 9 * * *", timezone: "Unknown/Zone" },
    },
    { ...create, skill: "missing" },
  ])("rejects invalid schedules and missing selected skills before mutation", async (action) => {
    const state = await fixture();

    try {
      await state.run(
        Effect.gen(function* () {
          const { context } = yield* recorded(action);
          expect(
            yield* (yield* ChatTasks).prepare(action, context).pipe(Effect.flip),
          ).toBeInstanceOf(AgentError);
          expect((yield* TaskRepository).list()).toEqual([]);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("rejects a prepared task once its one-off time has passed", async () => {
    const state = await fixture();

    const action: ChatTaskAction = {
      ...create,
      schedule: { type: "once", at: new Date(now + 1000).toISOString() },
    };

    try {
      await state.run(
        Effect.gen(function* () {
          const { context, store } = yield* recorded(action);
          const planned = yield* (yield* ChatTasks).prepare(action, context);
          yield* store.startToolCall(context.runId, context.callId);
          yield* TestClock.adjust("1 second");
          expect(yield* planned.execute.pipe(Effect.flip)).toMatchObject({
            reason: "invalid-request",
          });
          expect((yield* TaskRepository).list()).toEqual([]);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("rejects scheduled origin, unavailable here delivery, and unauthorized destinations", async () => {
    const state = await fixture();
    const action: ChatTaskAction = { ...create, delivery: "here" };

    try {
      await state.run(
        Effect.gen(function* () {
          const { context } = yield* recorded(action);
          const tasks = yield* ChatTasks;
          expect(
            yield* tasks.prepare(action, { ...context, origin: "scheduled" }).pipe(Effect.flip),
          ).toMatchObject({ reason: "tool-permission" });
          expect(yield* tasks.prepare(action, context).pipe(Effect.flip)).toMatchObject({
            reason: "tool-permission",
          });
          expect(
            yield* tasks
              .prepare(action, {
                ...context,
                here: Effect.fail(
                  new AgentError({ reason: "tool-permission", message: "Forbidden" }),
                ),
              })
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "tool-permission" });
          expect((yield* TaskRepository).list()).toEqual([]);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("cancellation during destination lookup cannot create a task later", async () => {
    const state = await fixture();
    const action: ChatTaskAction = { ...create, delivery: "here" };

    try {
      await state.run(
        Effect.gen(function* () {
          const { context } = yield* recorded(action);
          const ready = yield* Deferred.make<void>();

          const here = Effect.gen(function* () {
            yield* Deferred.succeed(ready, undefined);

            return yield* Effect.never;
          });

          const fiber = yield* (yield* ChatTasks)
            .prepare(action, { ...context, here })
            .pipe(Effect.forkChild);

          yield* Deferred.await(ready);
          yield* Fiber.interrupt(fiber);
          expect((yield* TaskRepository).list()).toEqual([]);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("the destination deadline cancels lookup before creating a task", async () => {
    const state = await fixture();
    const action: ChatTaskAction = { ...create, delivery: "here" };
    let cancelled = false;

    try {
      await state.run(
        Effect.gen(function* () {
          const { context } = yield* recorded(action);

          const here = Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                cancelled = true;
              }),
            ),
          );

          const fiber = yield* (yield* ChatTasks)
            .prepare(action, { ...context, here })
            .pipe(Effect.forkChild);

          yield* TestClock.adjust("8 seconds");
          expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toMatchObject({
            reason: "tool-permission",
            message: "Current-conversation validation timed out.",
          });
          expect(cancelled).toBe(true);
          expect((yield* TaskRepository).list()).toEqual([]);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("pages task inspection within the byte budget and truncates long prompts", async () => {
    const state = await fixture(1024);

    try {
      await state.run(
        Effect.gen(function* () {
          const repo = yield* TaskRepository;

          const input = {
            name: "Summary",
            prompt: "🙂".repeat(4000),
            provider: "test-provider",
            model: "test-model",
            workload: "assistant" as const,
            schedule: { type: "once" as const, at: now + 60000 },
          };

          for (let i = 0; i < 15; i++) repo.add(input, now);
          const first = yield* recorded({ action: "list", after: null });
          let cursor: string | null = null;
          const ids: string[] = [];
          let index = 0;

          do {
            const action: ChatTaskAction = { action: "list", after: cursor };

            const { context } =
              index === 0 ? first : yield* recorded(action, `page-${index}`, first.run);

            const output = yield* execute(action, context);
            expect(Buffer.byteLength(output)).toBeLessThanOrEqual(1024);
            const page = JSON.parse(output);
            ids.push(...page.tasks.map((task: { id: string }) => task.id));
            cursor = page.nextCursor;
            index++;
            expect(index).toBeLessThan(16);
          } while (cursor !== null);

          expect(new Set(ids).size).toBe(15);
          const action: ChatTaskAction = { action: "show", id: ids[0]! };
          const { context } = yield* recorded(action, "show", first.run);
          const output = yield* execute(action, context);
          const result = JSON.parse(output);
          expect(Buffer.byteLength(output)).toBeLessThanOrEqual(1024);
          expect(result).toMatchObject({
            truncated: true,
            task: { id: ids[0], provider: "test-provider" },
          });
          expect(result.task.prompt.length).toBeGreaterThan(0);
          expect(input.prompt.startsWith(result.task.prompt)).toBe(true);
          expect(result.task.prompt.isWellFormed()).toBe(true);
        }),
      );
    } finally {
      await state.close();
    }
  });
});
