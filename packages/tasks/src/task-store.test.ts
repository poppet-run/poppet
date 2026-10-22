import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { Store, StoreDatabase, StoreLive } from "@poppet/store";
import { Effect, Layer } from "effect";

import { nextOccurrence, parseTimestamp, type NewTask } from "#src/task-schema";
import { makeTaskStore, recurringExpiry, type TaskStore } from "#src/task-store";

const start = Date.parse("2026-10-14T09:00:00Z");

const recurring: NewTask = {
  name: "Summary",
  prompt: "Summarize my notes",
  provider: "test-provider",
  model: "test-model",
  workload: "assistant",
  schedule: { type: "cron", expression: "* * * * *", timezone: "UTC" },
};

const once: NewTask = { ...recurring, schedule: { type: "once", at: start } };

const morning: NewTask = {
  ...recurring,
  schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
};

const fixture = async (catchUpMs = 0) => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-tasks-"));

  const config = Layer.succeed(AppConfig, {
    applicationName: "Test",
    dataDirectory: directory,
    notesDirectory: join(directory, "notes"),
    provider: "test-provider",
    model: "test-model",
  });

  const layer = StoreLive.pipe(Layer.provide(config));

  return {
    run: <A, E>(
      body: (
        repo: TaskStore,
        store: Store["Service"],
        database: StoreDatabase["Service"]["database"],
      ) => Effect.Effect<A, E>,
    ) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { database } = yield* StoreDatabase;
          const store = yield* Store;

          return yield* body(makeTaskStore(database, catchUpMs), store, database);
        }).pipe(Effect.provide(layer)),
      ),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

describe.concurrent("task schedules", () => {
  test("retains a one-off rearmed while paused and defers it behind an older explicit retry", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.sync(() => {
          const job = repo.add(once, start);
          repo.reconcile(start);
          const original = repo.claim(start)!;
          repo.finish(original.occurrence.id, "failed", "test", start);
          repo.pause(job.id, start);
          repo.control(
            {
              action: "edit",
              id: job.id,
              revision: 0,
              operationId: "rearm-paused",
              patch: { prompt: "New one-off", schedule: { type: "once", at: start + 1000 } },
            },
            start,
          );
          expect(repo.task(job.id).paused).toBe(1);
          repo.resume(job.id, start);
          expect(repo.task(job.id).nextAt).toBe(start + 1000);
          repo.retry(original.occurrence.id, start);
          expect(() => repo.reconcile(start + 1000)).not.toThrow();
          expect(repo.task(job.id).nextAt).toBe(start + 1000);
          expect(repo.claim(start + 1000)?.task).toMatchObject({
            revision: 0,
            prompt: once.prompt,
          });
          repo.finish(original.occurrence.id, "completed", null, start + 1000);
          repo.reconcile(start + 1000);
          expect(repo.claim(start + 1000)?.task).toMatchObject({
            revision: 1,
            prompt: "New one-off",
          });
          expect(repo.task(job.id).nextAt).toBeNull();
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("edits a queued one-off with a new snapshot, preserving identity, destination and replay receipts", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.sync(() => {
          const skill = { name: "review", content: "Read the selected note." };
          const job = repo.add(once, start, skill);
          repo.reconcile(start);
          const original = repo.occurrences(job.id)[0]!;

          const command = {
            action: "edit" as const,
            id: job.id,
            revision: 0,
            operationId: "edit",
            patch: { name: "Renamed", prompt: "Read the current decisions" },
          };

          const receipt = repo.control(command, start + 1);
          expect(receipt).toMatchObject({
            revision: 1,
            replacedOccurrenceIds: [original.id],
            baselineReset: false,
          });
          expect(repo.occurrence(original.id)).toMatchObject({
            status: "cancelled",
            reason: "task-edited",
            definition: { name: once.name, prompt: once.prompt },
          });
          const pending = repo.occurrence(receipt.occurrenceId!);
          expect(pending).toMatchObject({
            revision: 1,
            scheduledAt: start,
            availableAt: start,
            definition: { name: "Renamed", prompt: "Read the current decisions", skill },
          });
          expect(repo.task(job.id)).toMatchObject({
            id: job.id,
            provider: job.provider,
            model: job.model,
            nextAt: null,
            skill,
          });
          expect(repo.control(command, start + 2)).toEqual(receipt);
          expect(() =>
            repo.control({ ...command, patch: { name: "Different" } }, start + 2),
          ).toThrow("different task request");
          const noop = repo.control({ ...command, revision: 1, operationId: "noop" }, start + 3);
          expect(noop).toMatchObject({ revision: 1, changedFields: [], replacedOccurrenceIds: [] });
          expect(repo.changes(job.id)).toHaveLength(1);
          const claimed = repo.claim(start + 4)!;
          expect(claimed.task).toMatchObject({
            name: "Renamed",
            prompt: "Read the current decisions",
          });
          repo.finish(claimed.occurrence.id, "completed", null, start + 4);
          expect(repo.clear()).toBe(1);
          expect(repo.changes(job.id)).toEqual([]);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("edits paused and completed one-offs without resuming or rerunning them, and rearms only an explicit schedule", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.sync(() => {
          const job = repo.add(once, start);
          repo.pause(job.id, start);
          repo.control(
            {
              action: "edit",
              id: job.id,
              revision: 0,
              operationId: "paused",
              patch: { prompt: "New prompt" },
            },
            start,
          );
          expect(repo.task(job.id).paused).toBe(1);
          repo.resume(job.id, start);
          repo.reconcile(start);
          const item = repo.claim(start)!;
          repo.finish(item.occurrence.id, "completed", null, start);
          repo.control(
            {
              action: "edit",
              id: job.id,
              revision: 1,
              operationId: "done",
              patch: { name: "Finished" },
            },
            start + 1,
          );
          expect(repo.task(job.id).nextAt).toBeNull();
          expect(repo.claim(start + 1)).toBeNull();
          expect(() =>
            repo.control(
              {
                action: "edit",
                id: job.id,
                revision: 2,
                operationId: "past",
                patch: { schedule: { type: "once", at: start - 1 } },
              },
              start + 1,
            ),
          ).toThrow("future");
          repo.control(
            {
              action: "edit",
              id: job.id,
              revision: 2,
              operationId: "rearm",
              patch: { schedule: { type: "once", at: start + 1000 } },
            },
            start + 1,
          );
          repo.reconcile(start + 1000);
          expect(repo.claim(start + 1000)?.task).toMatchObject({
            name: "Finished",
            prompt: "New prompt",
            revision: 3,
          });
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("rejects stale definitions and running edits, and rolls back edits when recording their receipt fails", async () => {
    const state = await fixture();

    try {
      await state.run((repo, _store, database) =>
        Effect.sync(() => {
          const job = repo.add(once, start);
          repo.reconcile(start);

          const command = {
            action: "edit" as const,
            id: job.id,
            revision: 0,
            operationId: "change",
            patch: { name: "Changed" },
          };

          const before = repo.task(job.id);
          database.run(
            "CREATE TRIGGER reject_operation BEFORE INSERT ON job_operations BEGIN SELECT RAISE(ABORT, 'receipt failed'); END",
          );
          expect(() => repo.control(command, start)).toThrow("receipt failed");
          expect(repo.task(job.id)).toEqual(before);
          expect(repo.occurrences(job.id)).toHaveLength(1);
          expect(repo.occurrences(job.id)[0]?.status).toBe("pending");
          expect(repo.changes(job.id)).toEqual([]);
          database.run("DROP TRIGGER reject_operation");
          repo.control(command, start);
          expect(() => repo.control({ ...command, operationId: "stale" }, start)).toThrow(
            "definition changed",
          );
          repo.claim(start);
          expect(() =>
            repo.control({ ...command, revision: 1, operationId: "running" }, start),
          ).toThrow("running occurrence");
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("skip-next consumes exactly the inspected queued or future slot and cannot skip a second slot on replay", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.sync(() => {
          const job = repo.add(recurring, start);
          const target = repo.nextTarget(job.id)!;

          const command = {
            action: "skip-next" as const,
            id: job.id,
            revision: 0,
            operationId: "skip",
            target,
          };

          const receipt = repo.control(command, start);
          expect(repo.occurrence(receipt.occurrenceId!)).toMatchObject({
            status: "cancelled",
            scheduledAt: start + 60_000,
            reason: "skipped-by-owner",
          });
          expect(repo.task(job.id).nextAt).toBe(start + 120_000);
          expect(repo.control(command, start + 1)).toEqual(receipt);
          expect(() => repo.control({ ...command, operationId: "stale" }, start + 1)).toThrow(
            "next execution changed",
          );
          repo.reconcile(start + 120_000);
          const pending = repo.nextTarget(job.id)!;
          repo.control({ ...command, operationId: "pending", target: pending }, start + 120_000);
          expect(repo.task(job.id).nextAt).toBe(start + 180_000);
          const single = repo.add(once, start);
          repo.control(
            { ...command, id: single.id, operationId: "once", target: repo.nextTarget(single.id)! },
            start,
          );
          expect(repo.task(single.id).nextAt).toBeNull();
          expect(repo.claim(start + 120_000)).toBeNull();
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("persists a long snooze across restart, skips intervening slots and expires relative to ready time", async () => {
    const state = await fixture();
    const until = start + 3 * recurringExpiry;

    try {
      const saved = await state.run((repo) =>
        Effect.sync(() => {
          const job = repo.add(recurring, start);

          const command = {
            action: "snooze" as const,
            id: job.id,
            revision: 0,
            operationId: "hold",
            target: repo.nextTarget(job.id)!,
            until,
          };

          const receipt = repo.control(command, start);
          const target = repo.nextTarget(job.id)!;
          expect(repo.control({ ...command, operationId: "same", target }, start)).toMatchObject({
            changedFields: [],
          });
          expect(repo.changes(job.id)).toHaveLength(1);
          expect(() =>
            repo.control({ ...command, operationId: "earlier", target, until: until - 1 }, start),
          ).toThrow("later");
          expect(() =>
            repo.control({ ...command, operationId: "stale", until: until + 1 }, start),
          ).toThrow("next execution changed");
          expect(repo.claim(until - 1)).toBeNull();
          expect(repo.status().nextScheduledAt).toBe(until);

          return { id: job.id, occurrence: receipt.occurrenceId! };
        }),
      );

      await state.run((repo) =>
        Effect.sync(() => {
          repo.reconcile(until - 1, true);
          expect(repo.occurrence(saved.occurrence)).toMatchObject({
            status: "pending",
            scheduledAt: start + 60_000,
            availableAt: until,
          });
          expect(repo.claim(until - 1)).toBeNull();
          repo.blockProvider(recurring.provider, "quota", until);
          expect(repo.claim(until)).toBeNull();
          repo.resumeProvider(recurring.provider, until + 1);
          expect(repo.claim(until + 1)?.occurrence.id).toBe(saved.occurrence);
          repo.finish(saved.occurrence, "failed", "test", until + 1);
          repo.retry(saved.occurrence, until + 1);
          repo.blockProvider(recurring.provider, "quota", until + 1);
          repo.resumeProvider(recurring.provider, until + recurringExpiry);
          expect(repo.occurrence(saved.occurrence).status).toBe("expired");
          expect(() => repo.retry(saved.occurrence, until + recurringExpiry)).toThrow("expired");
          repo.reconcile(until + recurringExpiry);
          expect(repo.claim(until + recurringExpiry)).toBeNull();
          repo.reconcile(until + recurringExpiry + 60_000);
          expect(repo.claim(until + recurringExpiry + 60_000)?.occurrence.scheduledAt).toBe(
            until + recurringExpiry + 60_000,
          );
          expect(repo.skips(saved.id).length).toBeGreaterThan(0);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("keeps a snooze through prompt edits, clears it on schedule replacement and cancels it on pause", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.sync(() => {
          const job = repo.add(recurring, start);

          const held = repo.control(
            {
              action: "snooze",
              id: job.id,
              revision: 0,
              operationId: "hold",
              target: repo.nextTarget(job.id)!,
              until: start + 500_000,
            },
            start,
          );

          const edited = repo.control(
            {
              action: "edit",
              id: job.id,
              revision: 0,
              operationId: "prompt",
              patch: { prompt: "Updated" },
            },
            start,
          );

          expect(repo.occurrence(edited.occurrenceId!)).toMatchObject({
            availableAt: start + 500_000,
            scheduledAt: start + 60_000,
            definition: { prompt: "Updated" },
          });
          expect(repo.occurrence(held.occurrenceId!).status).toBe("cancelled");

          const changed = repo.control(
            {
              action: "edit",
              id: job.id,
              revision: 1,
              operationId: "schedule",
              patch: { schedule: { type: "cron", expression: "*/2 * * * *", timezone: "UTC" } },
            },
            start,
          );

          expect(changed.snoozeCleared).toBe(true);
          expect(repo.nextTarget(job.id)?.occurrenceId).toBeNull();
          repo.control(
            {
              action: "snooze",
              id: job.id,
              revision: 2,
              operationId: "held-again",
              target: repo.nextTarget(job.id)!,
              until: start + 600_000,
            },
            start,
          );
          repo.pause(job.id, start);
          expect(() =>
            repo.control(
              {
                action: "skip-next",
                id: job.id,
                revision: 2,
                operationId: "paused",
                target: repo.nextTarget(job.id)!,
              },
              start,
            ),
          ).toThrow("Resume");
          repo.resume(job.id, start + 600_000);
          expect(repo.nextTarget(job.id)?.availableAt).toBeGreaterThan(start + 600_000);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("run-now preserves cron cadence, reuses eligible work, rejects held work and consumes a one-off early", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.sync(() => {
          const job = repo.add(recurring, start);

          const command = {
            action: "run-now" as const,
            id: job.id,
            revision: 0,
            operationId: "manual",
            target: repo.nextTarget(job.id)!,
          };

          const receipt = repo.control(command, start);
          expect(repo.task(job.id).nextAt).toBe(start + 60_000);
          expect(repo.occurrence(receipt.occurrenceId!)).toMatchObject({
            origin: "manual",
            scheduledAt: start,
            availableAt: start,
          });
          expect(repo.control(command, start + 1)).toEqual(receipt);

          const reused = repo.control(
            { ...command, operationId: "reuse", target: repo.nextTarget(job.id)! },
            start + 1,
          );

          expect(reused.occurrenceId).toBe(receipt.occurrenceId);
          expect(repo.changes(job.id)).toHaveLength(1);
          repo.cancel(receipt.occurrenceId!, start);
          expect(() => repo.control({ ...command, operationId: "collision" }, start)).toThrow(
            "already exists",
          );
          repo.control(
            {
              action: "snooze",
              id: job.id,
              revision: 0,
              operationId: "hold",
              target: repo.nextTarget(job.id)!,
              until: start + 120_000,
            },
            start,
          );
          expect(() =>
            repo.control(
              { ...command, operationId: "held", target: repo.nextTarget(job.id)! },
              start,
            ),
          ).toThrow("held");

          const single = repo.add(
            { ...once, schedule: { type: "once", at: start + 500_000 } },
            start,
          );

          const early = repo.control(
            {
              ...command,
              id: single.id,
              operationId: "early",
              target: repo.nextTarget(single.id)!,
            },
            start,
          );

          expect(repo.task(single.id).nextAt).toBeNull();
          expect(repo.occurrence(early.occurrenceId!)).toMatchObject({
            scheduledAt: start + 500_000,
            availableAt: start,
            origin: "manual",
          });
          expect(repo.claim(start)?.task.id).toBe(single.id);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("retries use historical definitions and their scheduling kind after the live task changes", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.sync(() => {
          const job = repo.add(once, start);
          repo.reconcile(start);
          const original = repo.claim(start)!;
          repo.finish(original.occurrence.id, "failed", "test", start);
          repo.control(
            {
              action: "edit",
              id: job.id,
              revision: 0,
              operationId: "new-definition",
              patch: { prompt: "Current", schedule: recurring.schedule },
            },
            start,
          );
          repo.retry(original.occurrence.id, start + 2 * recurringExpiry);
          expect(repo.claim(start + 2 * recurringExpiry)?.task).toMatchObject({
            prompt: once.prompt,
            schedule: once.schedule,
            revision: 0,
          });
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("keeps the queued destination on restart and explicit execution retry despite a changed task", async () => {
    const state = await fixture();

    const destination = {
      adapter: "discord",
      account: "bot",
      ownerId: "owner",
      scopeId: "guild",
      parentId: "parent",
      conversationId: "thread",
    };

    try {
      const item = await state.run((repo, _store, database) =>
        Effect.sync(() => {
          const job = repo.add(once, start, null, destination);
          repo.reconcile(start);
          const queued = repo.occurrences(job.id)[0]!;
          database.run("UPDATE jobs SET destination = ? WHERE id = ?", [
            JSON.stringify({ ...destination, conversationId: "other-thread" }),
            job.id,
          ]);

          return queued;
        }),
      );

      await state.run((repo) =>
        Effect.sync(() => {
          repo.recover(start + 1);
          expect(repo.occurrence(item.id).destination).toEqual(destination);
          repo.claim(start + 1);
          repo.finish(item.id, "failed", "test", start + 1);
          expect(repo.retry(item.id, start + 2).destination).toEqual(destination);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("status reports reconnect and quota actions without exposing failure messages or prompts", async () => {
    const state = await fixture();

    try {
      await state.run((repo, store) =>
        Effect.gen(function* () {
          const job = repo.add({ ...once, prompt: "private prompt" }, start);
          repo.reconcile(start);
          const active = repo.claim(start)!;
          const session = yield* store.createSession("test-provider", "test-model");
          const run = yield* store.queueRun(session.id, [{ role: "user", text: "private prompt" }]);
          yield* store.startRun(run.id);
          yield* store.finishRun(run.id, { status: "failed", reason: "provider:authentication" });
          repo.link(active.occurrence.id, session.id, run.id);
          repo.finish(active.occurrence.id, "failed", "private provider diagnostic", start);
          repo.blockProvider("test-provider", "quota", start);
          const overview = repo.status();

          expect(overview).toMatchObject({
            taskCount: 1,
            providers: ["test-provider"],
            pendingCount: 0,
            providerPauses: [
              {
                provider: "test-provider",
                action: "Run worker resume-provider test-provider when quota is available.",
              },
            ],
            recent: [
              {
                jobId: job.id,
                runId: run.id,
                failureReason: "provider:authentication",
                action: `Run auth login test-provider, then tasks retry ${active.occurrence.id}.`,
              },
            ],
          });
          expect(JSON.stringify(overview)).not.toContain("private prompt");
          expect(JSON.stringify(overview)).not.toContain("private provider diagnostic");
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("rolls back a failed quota-pause write and restores the pause from the saved run on restart", async () => {
    const state = await fixture();

    try {
      const saved = await state.run((repo, store, database) =>
        Effect.gen(function* () {
          repo.add(once, start);
          const next = repo.add({ ...once, schedule: { type: "once", at: start + 1 } }, start);
          repo.reconcile(start + 1);
          const active = repo.claim(start + 1)!;
          const session = yield* store.createSession("test-provider", "test-model");
          const queued = yield* store.queueRun(session.id, [{ role: "user", text: once.prompt }]);
          yield* store.startRun(queued.id);
          repo.link(active.occurrence.id, session.id, queued.id);
          yield* store.finishRun(queued.id, { status: "failed", reason: "provider:quota" });
          database.run(
            "CREATE TRIGGER reject_pause BEFORE INSERT ON job_provider_pauses BEGIN SELECT RAISE(ABORT, 'Pause write failed'); END",
          );

          expect(() =>
            repo.finish(active.occurrence.id, "failed", "Quota", start + 1, "quota"),
          ).toThrow("Pause write failed");
          expect(repo.occurrence(active.occurrence.id).status).toBe("running");
          expect(repo.providers()).toEqual([]);
          database.run("DROP TRIGGER reject_pause");

          return { occurrence: active.occurrence.id, run: queued.id, next: next.id };
        }),
      );

      await state.run((repo, store) =>
        Effect.gen(function* () {
          repo.recover(start + 1000);
          expect(repo.providers()).toMatchObject([
            { provider: "test-provider", reason: "quota", resumeAt: null },
          ]);
          expect(repo.occurrence(saved.occurrence).status).toBe("interrupted");
          expect((yield* store.run(saved.run))?.failureReason).toBe("provider:quota");
          expect(repo.claim(start + 1000)).toBeNull();
          repo.resumeProvider("test-provider", start + 1000);
          repo.recover(start + 2000);
          expect(repo.providers()).toEqual([]);
          expect(repo.claim(start + 2000)?.task.id).toBe(saved.next);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("clears tasks and their history while retaining conversations, facts, and provider pauses", async () => {
    const state = await fixture();

    try {
      await state.run((repo, store, database) =>
        Effect.gen(function* () {
          const single = repo.add(once, start);
          const recurringJob = repo.add(recurring, start);
          repo.reconcile(start + 60_000);
          const active = repo.claim(start + 60_000)!;
          expect(() => repo.clear()).toThrow("Interrupt active work");
          expect(repo.list()).toHaveLength(2);
          const session = yield* store.createSession("test-provider", "test-model");
          const pending = yield* store.queueRun(session.id, [{ role: "user", text: once.prompt }]);
          yield* store.startRun(pending.id);

          const completed = yield* store.finishRun(pending.id, {
            status: "completed",
            response: {
              output: [{ type: "text", text: "Saved answer" }],
              continuation: {
                version: 1,
                provider: "test-provider",
                model: "test-model",
                data: {},
              },
              finishReason: "stop",
              usage: null,
            },
          });

          repo.link(active.occurrence.id, session.id, completed.id);
          repo.finish(active.occurrence.id, "completed", null, start + 60_000);
          database.run(
            "INSERT INTO memories (key, value, source_run_id, updated_at) VALUES ('project', 'Acorn', ?, ?)",
            [completed.id, start],
          );
          repo.blockProvider("test-provider", "quota", start);
          repo.reconcile(start + 2 * 60_000);
          expect(repo.skips(recurringJob.id)).toHaveLength(1);

          expect(repo.clear()).toBe(2);
          expect(repo.clear()).toBe(0);
          expect(repo.list()).toEqual([]);
          expect(repo.occurrences(single.id)).toEqual([]);
          expect(repo.occurrences(recurringJob.id)).toEqual([]);
          expect(repo.skips(recurringJob.id)).toEqual([]);
          expect(repo.providers()).toMatchObject([{ provider: "test-provider", reason: "quota" }]);
          expect(yield* store.run(completed.id)).toEqual(completed);
          expect((yield* store.messages(session.id)).map((entry) => entry.message.role)).toEqual([
            "user",
            "assistant",
          ]);

          using fact = database.prepare(
            "SELECT value, source_run_id FROM memories WHERE key = 'project'",
          );

          expect(fact.get()).toEqual({ value: "Acorn", source_run_id: completed.id });
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("rolls back enqueued occurrences and schedule advancement together if reconciliation fails", async () => {
    const state = await fixture();

    try {
      await state.run((repo, _store, database) =>
        Effect.sync(() => {
          const first = repo.add(recurring, start);
          const second = repo.add(recurring, start + 1);
          database.run("UPDATE jobs SET schedule = ? WHERE id = ?", [
            JSON.stringify({ ...recurring.schedule, timezone: "Invalid/Zone" }),
            second.id,
          ]);

          expect(() => repo.reconcile(start + 60_000)).toThrow("Invalid cron");
          expect(repo.occurrences(first.id)).toEqual([]);
          expect(repo.task(first.id).nextAt).toBe(start + 60_000);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("recovers an answer committed before the task outcome, without replaying it", async () => {
    const state = await fixture();

    try {
      const id = await state.run((repo, store) =>
        Effect.gen(function* () {
          repo.add(once, start);
          repo.reconcile(start);
          const active = repo.claim(start)!;
          const session = yield* store.createSession("test-provider", "test-model");
          const queued = yield* store.queueRun(session.id, [{ role: "user", text: once.prompt }]);
          yield* store.startRun(queued.id);
          repo.link(active.occurrence.id, session.id, queued.id);
          yield* store.finishRun(queued.id, {
            status: "completed",
            response: {
              output: [{ type: "text", text: "Saved answer" }],
              continuation: {
                version: 1,
                provider: "test-provider",
                model: "test-model",
                data: {},
              },
              finishReason: "stop",
              usage: null,
            },
          });

          return active.occurrence.id;
        }),
      );

      await state.run((repo, store) =>
        Effect.gen(function* () {
          repo.reconcile(start + 1000, true);
          const item = repo.occurrence(id);
          expect(item.status).toBe("completed");
          expect((yield* store.run(item.runId!))?.result?.output).toEqual([
            { type: "text", text: "Saved answer" },
          ]);
          expect(repo.claim(start + 1000)).toBeNull();
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("keeps local wall time across DST, shifts missing times forward, and runs repeated times once", () => {
    const schedule = { type: "cron", expression: "30 1 * * *", timezone: "Europe/London" } as const;
    const spring = nextOccurrence(schedule, Date.parse("2026-03-28T23:00:00Z"));
    const autumn = nextOccurrence(schedule, Date.parse("2026-10-24T23:00:00Z"));

    expect(spring).toBe(Date.parse("2026-03-29T01:30:00Z"));
    expect(nextOccurrence(schedule, spring!)).toBe(Date.parse("2026-03-30T00:30:00Z"));
    expect(autumn).toBe(Date.parse("2026-10-25T00:30:00Z"));
    expect(nextOccurrence(schedule, autumn!)).toBe(Date.parse("2026-10-26T01:30:00Z"));
    expect(parseTimestamp("2026-10-14T10:00:00+01:00")).toBe(start);
    expect(() => parseTimestamp("2026-02-31T09:00:00Z")).toThrow("ISO timestamp");
    expect(() => parseTimestamp("2026-10-14T09:00:00")).toThrow("explicit offset");
    expect(() => nextOccurrence({ ...schedule, timezone: "Mars/Olympus" }, start)).toThrow(
      "Invalid cron",
    );
    expect(() => nextOccurrence({ ...schedule, expression: "* * * * * *" }, start)).toThrow(
      "five-field",
    );
    expect(() => nextOccurrence({ ...schedule, expression: "0 9 31 2 *" }, start)).toThrow(
      "upcoming occurrence",
    );
  });

  test("atomically advances schedules, skips downtime, and runs an overdue one-off once", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.sync(() => {
          const daily = repo.add(recurring, start);
          const single = repo.add(once, start);
          repo.reconcile(start + 10 * 60_000, true);
          repo.reconcile(start + 10 * 60_000, true);

          expect(repo.occurrences(daily.id)).toEqual([]);
          expect(repo.skips(daily.id)).toEqual([
            { firstAt: start + 60_000, lastAt: start + 10 * 60_000, reason: "downtime" },
          ]);
          expect(repo.task(daily.id).nextAt).toBe(start + 11 * 60_000);
          expect(repo.task(single.id).nextAt).toBeNull();
          expect(repo.occurrences(single.id)).toHaveLength(1);

          repo.reconcile(start + 11 * 60_000);
          repo.reconcile(start + 11 * 60_000);
          expect(repo.occurrences(daily.id)).toHaveLength(1);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("runs the latest missed recurring time once within the catch-up window", async () => {
    const state = await fixture(60 * 60_000);

    try {
      await state.run((repo) =>
        Effect.sync(() => {
          const job = repo.add(morning, start - 60_000);

          // A worker that starts shortly after 09:00 still runs that morning's occurrence.
          repo.reconcile(start + 5 * 60_000, true);
          repo.reconcile(start + 5 * 60_000, true);
          expect(repo.occurrences(job.id).map((item) => item.scheduledAt)).toEqual([start]);
          expect(repo.skips(job.id)).toEqual([]);
          expect(repo.task(job.id).nextAt).toBe(start + 24 * 60 * 60_000);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test.each([true, false])(
    "skips recurring times older than the catch-up window, at startup: %s",
    async (startup) => {
      const state = await fixture(60 * 60_000);

      try {
        await state.run((repo) =>
          Effect.sync(() => {
            const job = repo.add(morning, start - 60_000);
            const late = start + 2 * 60 * 60_000;

            repo.reconcile(late, startup);
            expect(repo.occurrences(job.id)).toEqual([]);
            expect(repo.skips(job.id)).toEqual([
              { firstAt: start, lastAt: late, reason: startup ? "downtime" : "worker-delayed" },
            ]);
            expect(repo.task(job.id).nextAt).toBe(start + 24 * 60 * 60_000);
          }),
        );
      } finally {
        await state.close();
      }
    },
  );

  test("after a long outage runs only the most recent recurring time and records the rest", async () => {
    const state = await fixture(60 * 60_000);

    try {
      await state.run((repo) =>
        Effect.sync(() => {
          const job = repo.add(morning, start - 60_000);
          const twoDaysLater = start + 2 * 24 * 60 * 60_000;

          repo.reconcile(twoDaysLater + 10 * 60_000, true);
          expect(repo.occurrences(job.id).map((item) => item.scheduledAt)).toEqual([twoDaysLater]);
          expect(repo.skips(job.id)).toEqual([
            { firstAt: start, lastAt: twoDaysLater - 1, reason: "downtime" },
          ]);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("long-running work skips later occurrences; pausing leaves active work for explicit cancellation", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.sync(() => {
          const job = repo.add(recurring, start);
          repo.reconcile(start + 60_000);
          const active = repo.claim(start + 60_000);
          expect(active).not.toBeNull();
          repo.reconcile(start + 5 * 60_000);
          expect(repo.occurrences(job.id)).toHaveLength(1);
          expect(repo.skips(job.id)).toEqual([
            {
              firstAt: start + 2 * 60_000,
              lastAt: start + 5 * 60_000,
              reason: "previous-occurrence-active",
            },
          ]);
          repo.pause(job.id, start + 5 * 60_000);
          expect(repo.occurrence(active!.occurrence.id).status).toBe("running");
          repo.cancel(active!.occurrence.id, start + 5 * 60_000);
          repo.finish(active!.occurrence.id, "interrupted", "cancelled", start + 5 * 60_000);
          expect(repo.occurrence(active!.occurrence.id).status).toBe("cancelled");
          repo.resume(job.id, start + 5 * 60_000);
          repo.reconcile(start + 6 * 60_000);
          repo.pause(job.id, start + 6 * 60_000);
          expect(repo.occurrences(job.id).map((item) => item.status)).toEqual([
            "cancelled",
            "cancelled",
          ]);
          expect(repo.claim(start + 6 * 60_000)).toBeNull();
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("preserves pending work across restart and interrupts active work for manual retry", async () => {
    const state = await fixture();

    try {
      const saved = await state.run((repo, store) =>
        Effect.gen(function* () {
          const first = repo.add(once, start);
          const second = repo.add({ ...once, schedule: { type: "once", at: start + 1 } }, start);
          repo.reconcile(start + 1);
          const active = repo.claim(start)!;
          const session = yield* store.createSession("test-provider", "test-model");
          const queued = yield* store.queueRun(session.id, [{ role: "user", text: first.prompt }]);
          const running = yield* store.startRun(queued.id);
          repo.link(active.occurrence.id, session.id, running.id);

          return {
            active: active.occurrence.id,
            pending: repo.occurrences(second.id)[0]!.id,
            run: running.id,
          };
        }),
      );

      await state.run((repo, store) =>
        Effect.gen(function* () {
          repo.reconcile(start + 1000, true);
          expect(repo.occurrence(saved.active).status).toBe("interrupted");
          expect(repo.occurrence(saved.pending).status).toBe("pending");
          expect((yield* store.run(saved.run))?.status).toBe("interrupted");
          expect(repo.retry(saved.active, start + 1000).status).toBe("pending");
          repo.reconcile(start + 1000, true);
          expect(repo.list()).toHaveLength(2);
          expect(repo.occurrences(repo.occurrence(saved.active).jobId)).toHaveLength(1);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("holds one recurring occurrence during quota pause, expires stale summaries, and retains one-offs", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.sync(() => {
          const job = repo.add(recurring, start);
          const single = repo.add(once, start);
          const other = repo.add({ ...once, provider: "another-provider" }, start);
          repo.blockProvider("test-provider", "quota", start);
          repo.reconcile(start + 60_000);
          repo.reconcile(start + 5 * 60_000);
          expect(repo.occurrences(job.id)).toHaveLength(1);
          expect(repo.claim(start + 5 * 60_000)?.task.id).toBe(other.id);
          expect(repo.claim(start + 5 * 60_000)).toBeNull();
          repo.resumeProvider("test-provider", start + recurringExpiry + 60_000);
          expect(repo.occurrences(job.id)[0]?.status).toBe("expired");
          expect(repo.occurrences(single.id)[0]?.status).toBe("pending");
          expect(repo.claim(start + recurringExpiry + 60_000)?.task.id).toBe(single.id);
          expect(() =>
            repo.retry(repo.occurrences(job.id)[0]!.id, start + recurringExpiry + 60_000),
          ).toThrow("expired");
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("temporary failures delay future work with bounded backoff without replaying failed occurrences", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.sync(() => {
          const first = repo.add(once, start);
          repo.add({ ...once, schedule: { type: "once", at: start + 1 } }, start);
          repo.reconcile(start + 1);
          const active = repo.claim(start)!;
          repo.finish(active.occurrence.id, "failed", "temporary", start, "temporary");
          expect(repo.claim(start + 29_999)).toBeNull();
          expect(repo.claim(start + 30_000)).not.toBeNull();
          expect(repo.occurrences(first.id)[0]?.status).toBe("failed");

          for (let attempt = 0; attempt < 10; attempt++)
            repo.blockProvider("test-provider", "rate-limit", start);
          expect(repo.providers()[0]?.resumeAt).toBe(start + 300_000);
        }),
      );
    } finally {
      await state.close();
    }
  });
});
