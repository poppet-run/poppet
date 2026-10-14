import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, AgentLive, ChatSettingsLive, ModelResolver, NotesLive } from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { LocalMemoryLive, Memory } from "@poppet/memory";
import {
  ProviderError,
  type ModelOperations,
  type ModelRequest,
  type Output,
} from "@poppet/provider";
import { Store, StoreDatabase, StoreLive } from "@poppet/store";
import { Console, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";

import { executeOccurrence, reconcileTasks, runTaskWorker } from "#src/scheduler";
import { TaskError, type NewTask } from "#src/task-schema";
import { remoteTaskCommand, taskSocketPath } from "#src/task-socket";
import { TaskRepository, TaskRepositoryLive } from "#src/task-store";
import { executeTaskCommand } from "#src/tasks";

const response = (output: ReadonlyArray<Output>) =>
  Stream.make({
    type: "completed" as const,
    response: {
      output,
      continuation: {
        version: 1 as const,
        provider: "test-provider",
        model: "test-model",
        data: {},
      },
      usage: null,
      finishReason: output.some((part) => part.type === "tool-call")
        ? ("tool-calls" as const)
        : ("stop" as const),
    },
  });

const final = () => response([{ type: "text", text: "Acorn summary" }]);

const fixture = async (stream: ModelOperations["stream"]) => {
  const directory = await mkdtemp(join(tmpdir(), "p7-"));
  const notesDirectory = join(directory, "notes");
  await mkdir(notesDirectory);
  await writeFile(join(notesDirectory, "project.md"), "The project is Acorn.");
  const requests: ModelRequest[] = [];
  const lines: string[] = [];
  const errors: string[] = [];

  const output: Console.Console = {
    ...console,
    log: (...values) => {
      lines.push(values.join(" "));
    },
    error: (...values) => {
      errors.push(values.join(" "));
    },
  };

  const config = Layer.succeed(AppConfig, {
    applicationName: "Test",
    dataDirectory: directory,
    notesDirectory,
    provider: "test-provider",
    model: "test-model",
  });

  const model: ModelOperations = {
    description: {
      provider: "test-provider",
      id: "test-model",
      name: "Test",
      capabilities: {
        tools: true,
        generationSettings: [],
        contextWindow: null,
        maxOutputTokens: null,
      },
    },
    stream: (request) => {
      requests.push(request);

      return stream(request);
    },
  };

  const store = StoreLive.pipe(Layer.provideMerge(config));
  const memory = LocalMemoryLive.pipe(Layer.provideMerge(store));
  const tasks = TaskRepositoryLive.pipe(Layer.provideMerge(store));

  const agent = AgentLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        store,
        memory,
        ChatSettingsLive,
        NotesLive.pipe(Layer.provide(Layer.merge(config, ChatSettingsLive))),
        Layer.succeed(ModelResolver, { resolve: () => Effect.succeed(model) }),
      ),
    ),
  );

  const layer = Layer.merge(agent, tasks);

  const task: NewTask = {
    name: "Summary",
    prompt: "Summarize project.md",
    provider: "test-provider",
    model: "test-model",
    workload: "assistant",
    schedule: { type: "once", at: 0 },
  };

  return {
    directory,
    notesDirectory,
    requests,
    lines,
    errors,
    task,
    run: <A, E>(
      program: Effect.Effect<
        A,
        E,
        Agent | Store | StoreDatabase | Memory | TaskRepository | AppConfig
      >,
    ) =>
      Effect.runPromise(
        program.pipe(Effect.provide(layer), Effect.provideService(Console.Console, output)),
      ),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

describe("task worker", () => {
  test("records an expired deadline as interrupted in both the occurrence and its run", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());

    const state = await fixture(() =>
      Stream.unwrap(Deferred.succeed(started, undefined).pipe(Effect.as(Stream.never))),
    );

    try {
      await state.run(
        Effect.gen(function* () {
          const repo = yield* TaskRepository;
          const store = yield* Store;
          repo.add(state.task, 0);
          repo.reconcile(0);
          const active = repo.claim(0)!;

          const running = yield* Effect.forkChild(
            executeOccurrence(repo, active.occurrence, active.task),
          );

          yield* Deferred.await(started);
          yield* TestClock.adjust("90 seconds");
          yield* Fiber.join(running);
          const occurrence = repo.occurrence(active.occurrence.id);

          expect(occurrence.status).toBe("interrupted");
          expect((yield* store.run(occurrence.runId!))?.status).toBe("interrupted");
          expect(state.lines.at(-1)).toContain(`occurrence=${occurrence.id} interrupted`);
          expect(state.errors).toEqual([]);
        }).pipe(Effect.provide(TestClock.layer())),
      );
    } finally {
      await state.close();
    }
  });

  test("clears active and pending work through the worker, retains its run, and continues serving", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());

    const state = await fixture(() =>
      Stream.unwrap(Deferred.succeed(started, undefined).pipe(Effect.as(Stream.never))),
    );

    try {
      await state.run(
        Effect.gen(function* () {
          const repo = yield* TaskRepository;
          const store = yield* Store;
          const job = repo.add(state.task, Date.now());
          const worker = yield* Effect.forkChild(runTaskWorker);
          yield* Effect.raceFirst(Deferred.await(started), Fiber.join(worker));
          const active = repo.occurrences(job.id)[0]!;
          const pending = repo.add(state.task, Date.now());
          repo.reconcile(Date.now());
          expect(repo.occurrences(pending.id)[0]?.status).toBe("pending");
          const path = taskSocketPath(state.directory);
          const result = yield* remoteTaskCommand(path, { action: "clear" });

          expect(result?.value).toEqual({ cleared: 2 });
          expect(repo.list()).toEqual([]);
          expect(repo.occurrences(job.id)).toEqual([]);
          expect(repo.occurrences(pending.id)).toEqual([]);
          expect((yield* store.run(active.runId!))?.status).toBe("interrupted");
          expect(state.requests).toHaveLength(1);
          expect(state.lines).toContainEqual(expect.stringContaining("All tasks cleared."));
          expect((yield* remoteTaskCommand(path, { action: "list" }))?.value).toEqual([]);

          const added = yield* remoteTaskCommand(path, {
            action: "add",
            task: { ...state.task, schedule: { type: "once", at: Date.now() + 60_000 } },
          });

          expect(added).not.toBeNull();
          expect(repo.list()).toHaveLength(1);
          yield* Fiber.interrupt(worker);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("logs committed downtime and busy skips once, without logging rolled-back changes", async () => {
    const state = await fixture(final);
    const start = Date.parse("2026-10-14T09:00:00Z");
    const schedule = { type: "cron", expression: "* * * * *", timezone: "UTC" } as const;

    try {
      await state.run(
        Effect.gen(function* () {
          const repo = yield* TaskRepository;
          const { database } = yield* StoreDatabase;
          const job = repo.add({ ...state.task, schedule }, start);
          yield* reconcileTasks(repo, start + 5 * 60_000, true);
          yield* reconcileTasks(repo, start + 6 * 60_000);
          yield* reconcileTasks(repo, start + 10 * 60_000);
          yield* reconcileTasks(repo, start + 10 * 60_000);

          expect(state.lines).toEqual([
            `[2026-10-14T09:05:00.000Z] Task "Summary" task=${job.id} skipped 2026-10-14T09:01:00.000Z to 2026-10-14T09:05:00.000Z reason=downtime`,
            `[2026-10-14T09:10:00.000Z] Task "Summary" task=${job.id} skipped 2026-10-14T09:07:00.000Z to 2026-10-14T09:10:00.000Z reason=previous-occurrence-active`,
          ]);
          const broken = repo.add({ ...state.task, schedule }, start + 1);
          database.run("UPDATE jobs SET schedule = ? WHERE id = ?", [
            JSON.stringify({ ...schedule, timezone: "Invalid/Zone" }),
            broken.id,
          ]);

          const error = yield* reconcileTasks(repo, start + 11 * 60_000).pipe(
            Effect.match({ onFailure: (failure) => failure, onSuccess: () => null }),
          );

          expect(error).toMatchObject({ message: expect.stringContaining("Invalid cron") });
          expect(state.lines).toHaveLength(2);
          expect(repo.skips(job.id)).toHaveLength(2);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("propagates a failed outcome write even when the model also failed", async () => {
    const state = await fixture(() =>
      Stream.fail(
        new ProviderError({
          provider: "test-provider",
          reason: "temporary",
          message: "Unavailable",
        }),
      ),
    );

    try {
      await state.run(
        Effect.gen(function* () {
          const repo = yield* TaskRepository;
          repo.add(state.task, Date.now());
          repo.reconcile(Date.now());
          const active = repo.claim(Date.now())!;

          const failing = {
            ...repo,
            finish: () => {
              throw new TaskError({ message: "Outcome write failed" });
            },
          };

          const error = yield* executeOccurrence(failing, active.occurrence, active.task).pipe(
            Effect.match({ onFailure: (failure) => failure, onSuccess: () => null }),
          );

          expect(error).toMatchObject({ message: "Outcome write failed" });
          expect(repo.occurrence(active.occurrence.id).status).toBe("running");
          expect(state.lines).toHaveLength(1);
          expect(state.errors).toEqual([]);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("uses fresh sessions and current memory, reads notes, and stores final answers", async () => {
    const state = await fixture((request) =>
      request.messages.some((message) => message.role === "tool")
        ? final()
        : response([
            {
              type: "tool-call",
              namespace: "poppet_notes",
              name: "read_note",
              callId: "read",
              arguments: '{"path":"project.md"}',
            },
          ]),
    );

    try {
      await state.run(
        Effect.gen(function* () {
          const repo = yield* TaskRepository;
          const store = yield* Store;
          const memory = yield* Memory;
          yield* memory.remember("style", "Concise");
          const first = repo.add(state.task, Date.now());
          repo.reconcile(Date.now());
          const active = repo.claim(Date.now())!;
          yield* executeOccurrence(repo, active.occurrence, active.task);
          yield* memory.replace("style", "Detailed");
          const second = repo.add(state.task, Date.now());
          repo.reconcile(Date.now());
          const next = repo.claim(Date.now())!;
          yield* executeOccurrence(repo, next.occurrence, next.task);

          const firstResult = yield* executeTaskCommand(
            repo,
            store,
            { action: "show", id: first.id },
            Date.now(),
          );

          const secondResult = repo.occurrences(second.id)[0]!;

          expect(firstResult).toMatchObject({
            occurrences: [
              { status: "completed", output: [{ type: "text", text: "Acorn summary" }] },
            ],
          });
          expect(repo.occurrences(first.id)[0]?.sessionId).not.toBe(secondResult.sessionId);
          expect(state.requests.map((request) => request.tools.map((tool) => tool.name))).toEqual(
            Array.from({ length: 4 }, () => ["read_note", "search_notes"]),
          );
          expect(state.requests[0]?.instructions).toContain("Concise");
          expect(state.requests[2]?.instructions).toContain("Detailed");
          expect(state.requests[2]?.messages).toHaveLength(1);
          expect(state.lines).toHaveLength(4);
          expect(state.lines[0]).toMatch(
            /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] Task "Summary" occurrence=/,
          );
          expect(state.lines[0]).toContain(`occurrence=${active.occurrence.id} started`);
          expect(state.lines[1]).toContain(`occurrence=${active.occurrence.id} completed`);
          expect(state.lines.join("\n")).not.toContain("Acorn");
          expect(state.lines.join("\n")).not.toContain(state.task.prompt);
          expect(state.errors).toEqual([]);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("rejects attempted note writes and permits only an explicit retry with a fresh session", async () => {
    let write = true;

    const state = await fixture(() =>
      write
        ? response([
            {
              type: "tool-call",
              namespace: "poppet_notes",
              name: "save_note",
              callId: "save",
              arguments: '{"path":"project.md","text":"Changed"}',
            },
          ])
        : final(),
    );

    try {
      await state.run(
        Effect.gen(function* () {
          const repo = yield* TaskRepository;
          const store = yield* Store;
          const job = repo.add(state.task, Date.now());
          repo.reconcile(Date.now());
          const claimed = repo.claim(Date.now())!;
          yield* executeOccurrence(repo, claimed.occurrence, claimed.task);
          const failed = repo.occurrence(claimed.occurrence.id);

          expect(failed.status).toBe("failed");
          expect((yield* store.run(failed.runId!))?.failureReason).toBe("agent:tool-permission");
          repo.reconcile(Date.now());
          expect(repo.claim(Date.now())).toBeNull();
          write = false;
          repo.retry(failed.id, Date.now());
          const retry = repo.claim(Date.now())!;
          yield* executeOccurrence(repo, retry.occurrence, retry.task);
          const completed = repo.occurrences(job.id)[0]!;

          expect(completed.status).toBe("completed");
          expect(completed.sessionId).not.toBe(failed.sessionId);
          expect((yield* store.run(failed.runId!))?.status).toBe("failed");
        }),
      );
      expect(await readFile(join(state.notesDirectory, "project.md"), "utf8")).toBe(
        "The project is Acorn.",
      );
    } finally {
      await state.close();
    }
  });

  test("persists quota pauses across restart and retains failed one-offs until explicit retry", async () => {
    let quota = true;

    const state = await fixture(() =>
      quota
        ? Stream.fail(
            new ProviderError({
              provider: "test-provider",
              reason: "quota",
              message: "Plan limit reached; private-provider-details",
            }),
          )
        : final(),
    );

    try {
      const saved = await state.run(
        Effect.gen(function* () {
          const repo = yield* TaskRepository;
          repo.add(state.task, Date.now());
          repo.reconcile(Date.now());
          const claimed = repo.claim(Date.now())!;
          yield* executeOccurrence(repo, claimed.occurrence, claimed.task);
          const held = repo.add(state.task, Date.now());
          repo.reconcile(Date.now());

          expect(repo.claim(Date.now())).toBeNull();
          expect(repo.providers()).toMatchObject([
            { provider: "test-provider", reason: "quota", resumeAt: null },
          ]);
          expect(state.errors[0]).toContain(
            `occurrence=${claimed.occurrence.id} failed reason=provider:quota`,
          );
          expect(state.lines.at(-1)).toContain(
            "Provider test-provider paused reason=quota; use tasks resume-provider test-provider",
          );
          expect([...state.lines, ...state.errors].join("\n")).not.toContain(
            "private-provider-details",
          );

          return { failed: claimed.occurrence.id, held: held.id };
        }),
      );

      await state.run(
        Effect.gen(function* () {
          const repo = yield* TaskRepository;
          repo.reconcile(Date.now(), true);
          expect(repo.claim(Date.now())).toBeNull();
          expect(repo.occurrence(saved.failed).status).toBe("failed");
          expect(state.requests).toHaveLength(1);
          quota = false;
          repo.resumeProvider("test-provider", Date.now());
          const held = repo.claim(Date.now())!;
          expect(held.task.id).toBe(saved.held);
          yield* executeOccurrence(repo, held.occurrence, held.task);
          repo.retry(saved.failed, Date.now());
          const retry = repo.claim(Date.now())!;
          yield* executeOccurrence(repo, retry.occurrence, retry.task);
          expect(repo.occurrence(saved.failed).status).toBe("completed");
          expect(repo.providers()).toEqual([]);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("accepts protected local commands while owning SQLite, cancels active work, and keeps serving", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const finished = await Effect.runPromise(Deferred.make<void>());
    let hang = true;

    const state = await fixture(() =>
      hang
        ? Stream.unwrap(Deferred.succeed(started, undefined).pipe(Effect.as(Stream.never)))
        : Stream.unwrap(Deferred.succeed(finished, undefined).pipe(Effect.as(final()))),
    );

    try {
      await state.run(
        Effect.gen(function* () {
          const repo = yield* TaskRepository;
          const store = yield* Store;
          const job = repo.add(state.task, Date.now());
          const worker = yield* Effect.forkChild(runTaskWorker);
          yield* Effect.raceFirst(Deferred.await(started), Fiber.join(worker));
          const path = taskSocketPath(state.directory);
          const mode = yield* Effect.promise(() => stat(path));
          expect(mode.mode & 0o777).toBe(0o600);
          const listing = yield* remoteTaskCommand(path, { action: "list" });
          expect(listing?.value).toMatchObject([{ id: job.id }]);
          const active = repo.occurrences(job.id)[0]!;
          yield* remoteTaskCommand(path, { action: "pause", id: job.id });
          expect(repo.occurrence(active.id).status).toBe("running");
          yield* remoteTaskCommand(path, { action: "cancel", id: active.id });
          expect(repo.occurrence(active.id).status).toBe("cancelled");
          expect((yield* store.run(active.runId!))?.status).toBe("interrupted");
          repo.blockProvider("test-provider", "quota", Date.now());
          yield* remoteTaskCommand(path, { action: "resume-provider", provider: "test-provider" });
          expect(state.lines).toContainEqual(
            expect.stringContaining("Provider test-provider resumed by request"),
          );
          hang = false;
          const added = yield* remoteTaskCommand(path, { action: "add", task: state.task });
          expect(added).not.toBeNull();
          yield* Deferred.await(finished);
          yield* Effect.yieldNow;
          expect(yield* remoteTaskCommand(path, { action: "list" })).not.toBeNull();
          yield* Fiber.interrupt(worker);
          expect(state.lines).toContainEqual(
            expect.stringContaining(`occurrence=${active.id} cancelled`),
          );
          expect(
            state.lines.filter((line) => line.includes(`occurrence=${active.id} cancelled`)),
          ).toHaveLength(1);
          expect(state.lines).toContainEqual(expect.stringContaining(`task=${job.id} paused`));
          expect(state.lines.at(-1)).toContain("Task worker stopped.");
        }),
      );
      expect(await Bun.file(taskSocketPath(state.directory)).exists()).toBe(false);
      expect(await Bun.file(join(state.directory, "store/owner.lock")).exists()).toBe(false);
    } finally {
      await state.close();
    }
  });

  test("advances due work under a controllable clock without duplicating occurrences", async () => {
    const done = await Effect.runPromise(Deferred.make<void>());

    const state = await fixture(() =>
      Stream.unwrap(Deferred.succeed(done, undefined).pipe(Effect.as(final()))),
    );

    try {
      await state.run(
        Effect.gen(function* () {
          const repo = yield* TaskRepository;
          const job = repo.add({ ...state.task, schedule: { type: "once", at: 60_000 } }, 0);
          const worker = yield* Effect.forkChild(runTaskWorker);
          yield* Effect.yieldNow;
          yield* TestClock.adjust("60 seconds");
          yield* Effect.raceFirst(Deferred.await(done), Fiber.join(worker));
          yield* TestClock.adjust("2 seconds");
          expect(repo.occurrences(job.id)).toHaveLength(1);
          expect(repo.occurrences(job.id)[0]?.status).toBe("completed");
          expect(state.requests).toHaveLength(1);
          yield* Fiber.interrupt(worker);
        }).pipe(Effect.provide(TestClock.layer())),
      );
    } finally {
      await state.close();
    }
  });
});
