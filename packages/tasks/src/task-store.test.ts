import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { memorySchema } from "@poppet/memory";
import { Store, StoreLive, migrate } from "@poppet/store";
import { Effect, Layer, Result } from "effect";
import { SqlClient } from "effect/sql";

import { taskSchema } from "#src/migrations";
import { recurringExpiry } from "#src/task-records";
import { nextOccurrence, parseTimestamp, type NewTask } from "#src/task-schema";
import { makeTaskStore, type TaskStore } from "#src/task-store";

const start = Date.parse("2026-10-14T09:00:00Z");

const recurring: NewTask = {
  name: "Summary",
  prompt: "Summarize recent conversations",
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
    provider: "test-provider",
    model: "test-model",
  });

  const layer = StoreLive.pipe(Layer.provide(config));

  return {
    run: <A, E>(
      body: (
        repo: TaskStore,
        store: Store["Service"],
        sql: SqlClient.SqlClient,
      ) => Effect.Effect<A, E>,
    ) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const store = yield* Store;
          yield* migrate(taskSchema);
          yield* migrate(memorySchema);

          return yield* body(makeTaskStore(sql, catchUpMs), store, sql);
        }).pipe(Effect.provide(layer)),
      ),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

describe.concurrent("TaskRepository", () => {
  test("webhook receipts survive restart and clearing, reject changed payloads, and retain restricted retries", async () => {
    const state = await fixture();

    try {
      const first = await state.run((repo) =>
        repo.acceptWebhook("deploy", "evt-1", "digest", once, start),
      );

      expect(first.status).toBe("accepted");

      if (first.status !== "accepted") throw new Error("Expected accepted event");
      await state.run((repo) =>
        Effect.gen(function* () {
          expect(yield* repo.acceptWebhook("deploy", "evt-1", "digest", once, start)).toEqual({
            ...first,
            status: "duplicate",
          });
          expect(
            (yield* repo.acceptWebhook("deploy", "evt-1", "changed", once, start)).status,
          ).toBe("conflict");
          yield* repo.reconcile(start, true);
          const item = (yield* repo.claim(start))!;
          expect(item.definition.source).toBe("webhook");
          yield* repo.finish(item.id, "failed", "test", start);
          yield* repo.retry(item.id, start + 1);
          expect((yield* repo.claim(start + 1))?.definition.source).toBe("webhook");
          yield* repo.finish(item.id, "completed", null, start + 1);
          yield* repo.clear();
          expect((yield* repo.acceptWebhook("deploy", "evt-1", "digest", once, start)).status).toBe(
            "duplicate",
          );
          expect(yield* repo.list()).toEqual([]);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("a failed webhook receipt rolls back the task and occurrence together", async () => {
    const state = await fixture();

    try {
      await state.run((repo, _store, sql) =>
        Effect.gen(function* () {
          yield* sql`CREATE TRIGGER reject_webhook BEFORE INSERT ON webhook_events
          BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`;

          const result = yield* repo
            .acceptWebhook("deploy", "event", "digest", once, start)
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          expect(yield* repo.list()).toEqual([]);
          expect(yield* repo.claim(start)).toBeNull();
          yield* sql`DROP TRIGGER reject_webhook`;
          expect((yield* repo.acceptWebhook("deploy", "event", "digest", once, start)).status).toBe(
            "accepted",
          );
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("webhook queue capacity rejects new events while allowing duplicate receipts", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.gen(function* () {
          for (let n = 0; n < 100; n++) {
            expect(
              (yield* repo.acceptWebhook("deploy", String(n), "digest", once, start)).status,
            ).toBe("accepted");
          }

          expect(
            (yield* repo.acceptWebhook("deploy", "overflow", "digest", once, start)).status,
          ).toBe("full");
          expect((yield* repo.acceptWebhook("deploy", "0", "digest", once, start)).status).toBe(
            "duplicate",
          );
          const item = (yield* repo.claim(start))!;
          yield* repo.finish(item.id, "completed", null, start);
          expect(
            (yield* repo.acceptWebhook("deploy", "overflow", "digest", once, start)).status,
          ).toBe("accepted");
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when a paused one-off is rearmed, retains it behind an older explicit retry", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.gen(function* () {
          const job = yield* repo.add(once, start);
          yield* repo.reconcile(start);
          const original = (yield* repo.claim(start))!;
          yield* repo.finish(original.id, "failed", "test", start);
          yield* repo.pause(job.id, start);
          yield* repo.control(
            {
              action: "edit",
              id: job.id,
              patch: { prompt: "New one-off", schedule: { type: "once", at: start + 1000 } },
            },
            start,
          );
          expect((yield* repo.task(job.id)).paused).toBe(1);
          yield* repo.resume(job.id, start);
          expect((yield* repo.task(job.id)).nextAt).toBe(start + 1000);
          yield* repo.retry(original.id, start);
          yield* repo.reconcile(start + 1000);
          expect((yield* repo.task(job.id)).nextAt).toBe(start + 1000);
          expect(yield* repo.claim(start + 1000)).toMatchObject({
            revision: 0,
            definition: { prompt: once.prompt },
          });
          yield* repo.finish(original.id, "completed", null, start + 1000);
          yield* repo.reconcile(start + 1000);
          expect(yield* repo.claim(start + 1000)).toMatchObject({
            revision: 1,
            definition: { prompt: "New one-off" },
          });
          expect((yield* repo.task(job.id)).nextAt).toBeNull();
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when a queued one-off is edited, replaces its snapshot while preserving identity and destination", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.gen(function* () {
          const skill = { name: "review", content: "Read the selected conversation." };
          const job = yield* repo.add(once, start, skill);
          yield* repo.reconcile(start);
          const original = (yield* repo.occurrences(job.id))[0]!;

          const command = {
            action: "edit" as const,
            id: job.id,
            patch: { name: "Renamed", prompt: "Read the current decisions" },
          };

          const receipt = yield* repo.control(command, start + 1);
          expect(receipt).toMatchObject({
            changedFields: ["name", "prompt"],
            replacedOccurrenceIds: [original.id],
          });
          expect(yield* repo.occurrence(original.id)).toMatchObject({
            status: "cancelled",
            reason: "task-edited",
            definition: { name: once.name, prompt: once.prompt },
          });
          const pending = yield* repo.occurrence(receipt.occurrenceId!);
          expect(pending).toMatchObject({
            revision: 1,
            scheduledAt: start,
            availableAt: start,
            definition: { name: "Renamed", prompt: "Read the current decisions", skill },
          });
          expect(yield* repo.task(job.id)).toMatchObject({
            id: job.id,
            provider: job.provider,
            model: job.model,
            nextAt: null,
            skill,
          });

          const noop = yield* repo.control(command, start + 3);

          expect(noop).toMatchObject({ changedFields: [], replacedOccurrenceIds: [] });
          const claimed = (yield* repo.claim(start + 4))!;
          expect(claimed.definition).toMatchObject({
            name: "Renamed",
            prompt: "Read the current decisions",
          });
          yield* repo.finish(claimed.id, "completed", null, start + 4);
          expect(yield* repo.clear()).toBe(1);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when paused or completed one-offs are edited, rearms only explicit schedule changes without resuming or rerunning", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.gen(function* () {
          const job = yield* repo.add(once, start);
          yield* repo.pause(job.id, start);
          yield* repo.control(
            {
              action: "edit",
              id: job.id,
              patch: { prompt: "New prompt" },
            },
            start,
          );
          expect((yield* repo.task(job.id)).paused).toBe(1);
          yield* repo.resume(job.id, start);
          yield* repo.reconcile(start);
          const item = (yield* repo.claim(start))!;
          yield* repo.finish(item.id, "completed", null, start);
          yield* repo.control(
            {
              action: "edit",
              id: job.id,
              patch: { name: "Finished" },
            },
            start + 1,
          );
          expect((yield* repo.task(job.id)).nextAt).toBeNull();
          expect(yield* repo.claim(start + 1)).toBeNull();
          expect(
            (yield* Effect.flip(
              repo.control(
                {
                  action: "edit",
                  id: job.id,
                  patch: { schedule: { type: "once", at: start - 1 } },
                },
                start + 1,
              ),
            )).message,
          ).toContain("future");
          yield* repo.control(
            {
              action: "edit",
              id: job.id,
              patch: { schedule: { type: "once", at: start + 1000 } },
            },
            start + 1,
          );
          yield* repo.reconcile(start + 1000);
          expect(yield* repo.claim(start + 1000)).toMatchObject({
            definition: { name: "Finished", prompt: "New prompt" },
            revision: 3,
          });
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when a task was edited since it was last read, applies further edits until an occurrence is running", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.gen(function* () {
          const job = yield* repo.add(once, start);
          yield* repo.reconcile(start);

          const command = {
            action: "edit" as const,
            id: job.id,
            patch: { name: "Changed" },
          };

          yield* repo.control(command, start);
          yield* repo.control({ ...command, patch: { name: "Changed again" } }, start);
          expect(yield* repo.task(job.id)).toMatchObject({ name: "Changed again", revision: 2 });
          yield* repo.claim(start);
          expect((yield* Effect.flip(repo.control(command, start))).message).toContain(
            "running occurrence",
          );
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when skip-next is repeated, consumes the current pending occurrence or next slot each time", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.gen(function* () {
          const job = yield* repo.add(recurring, start);
          const command = { action: "skip-next" as const, id: job.id };
          const receipt = yield* repo.control(command, start);
          expect(yield* repo.occurrence(receipt.occurrenceId!)).toMatchObject({
            status: "cancelled",
            scheduledAt: start + 60_000,
            reason: "skipped-by-owner",
          });
          expect((yield* repo.task(job.id)).nextAt).toBe(start + 120_000);
          const repeated = yield* repo.control(command, start + 1);
          expect(yield* repo.occurrence(repeated.occurrenceId!)).toMatchObject({
            status: "cancelled",
            scheduledAt: start + 120_000,
          });
          expect((yield* repo.task(job.id)).nextAt).toBe(start + 180_000);
          yield* repo.reconcile(start + 180_000);
          const pending = (yield* repo.nextTarget(job.id))!;
          expect((yield* repo.control(command, start + 180_000)).occurrenceId).toBe(
            pending.occurrenceId,
          );
          expect((yield* repo.occurrence(pending.occurrenceId!)).status).toBe("cancelled");
          expect((yield* repo.task(job.id)).nextAt).toBe(start + 240_000);
          const single = yield* repo.add(once, start);
          yield* repo.control({ ...command, id: single.id }, start);
          expect((yield* repo.task(single.id)).nextAt).toBeNull();
          expect(
            (yield* Effect.flip(repo.control({ ...command, id: single.id }, start))).message,
          ).toContain("no upcoming execution");
          expect(yield* repo.claim(start + 180_000)).toBeNull();
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when a long snooze survives restart, skips intervening slots and expires relative to ready time", async () => {
    const state = await fixture();
    const until = start + 3 * recurringExpiry;

    try {
      const saved = await state.run((repo) =>
        Effect.gen(function* () {
          const job = yield* repo.add(recurring, start);

          const command = {
            action: "snooze" as const,
            id: job.id,
            until,
          };

          const receipt = yield* repo.control(command, start);
          expect(yield* repo.control(command, start)).toMatchObject({
            changedFields: [],
          });
          expect(
            (yield* Effect.flip(repo.control({ ...command, until: until - 1 }, start))).message,
          ).toContain("later");
          expect(
            (yield* Effect.flip(repo.control({ ...command, until: start }, start))).message,
          ).toContain("future");
          expect(yield* repo.claim(until - 1)).toBeNull();
          expect((yield* repo.status()).nextScheduledAt).toBe(until);

          return { id: job.id, occurrence: receipt.occurrenceId! };
        }),
      );

      await state.run((repo) =>
        Effect.gen(function* () {
          yield* repo.reconcile(until - 1, true);
          expect(yield* repo.occurrence(saved.occurrence)).toMatchObject({
            status: "pending",
            scheduledAt: start + 60_000,
            availableAt: until,
          });
          expect(yield* repo.claim(until - 1)).toBeNull();
          yield* repo.blockProvider(recurring.provider, "quota", until);
          expect(yield* repo.claim(until)).toBeNull();
          yield* repo.resumeProvider(recurring.provider, until + 1);
          expect((yield* repo.claim(until + 1))?.id).toBe(saved.occurrence);
          yield* repo.finish(saved.occurrence, "failed", "test", until + 1);
          yield* repo.retry(saved.occurrence, until + 1);
          yield* repo.blockProvider(recurring.provider, "quota", until + 1);
          yield* repo.resumeProvider(recurring.provider, until + recurringExpiry);
          expect((yield* repo.occurrence(saved.occurrence)).status).toBe("expired");
          expect(
            (yield* Effect.flip(repo.retry(saved.occurrence, until + recurringExpiry))).message,
          ).toContain("expired");
          yield* repo.reconcile(until + recurringExpiry);
          expect(yield* repo.claim(until + recurringExpiry)).toBeNull();
          yield* repo.reconcile(until + recurringExpiry + 60_000);
          expect((yield* repo.claim(until + recurringExpiry + 60_000))?.scheduledAt).toBe(
            until + recurringExpiry + 60_000,
          );
          expect((yield* repo.skips(saved.id)).length).toBeGreaterThan(0);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when snoozed tasks change, retains snooze for prompt edits and clears it for schedule replacement or pause", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.gen(function* () {
          const job = yield* repo.add(recurring, start);

          const held = yield* repo.control(
            {
              action: "snooze",
              id: job.id,
              until: start + 500_000,
            },
            start,
          );

          const edited = yield* repo.control(
            {
              action: "edit",
              id: job.id,
              patch: { prompt: "Updated" },
            },
            start,
          );

          expect(yield* repo.occurrence(edited.occurrenceId!)).toMatchObject({
            availableAt: start + 500_000,
            scheduledAt: start + 60_000,
            definition: { prompt: "Updated" },
          });
          expect((yield* repo.occurrence(held.occurrenceId!)).status).toBe("cancelled");

          const changed = yield* repo.control(
            {
              action: "edit",
              id: job.id,
              patch: { schedule: { type: "cron", expression: "*/2 * * * *", timezone: "UTC" } },
            },
            start,
          );

          expect(changed.snoozeCleared).toBe(true);
          expect((yield* repo.nextTarget(job.id))?.occurrenceId).toBeNull();
          yield* repo.control(
            {
              action: "snooze",
              id: job.id,
              until: start + 600_000,
            },
            start,
          );
          yield* repo.pause(job.id, start);
          expect(
            (yield* Effect.flip(
              repo.control(
                {
                  action: "skip-next",
                  id: job.id,
                },
                start,
              ),
            )).message,
          ).toContain("Resume");
          yield* repo.resume(job.id, start + 600_000);
          expect((yield* repo.nextTarget(job.id))?.availableAt).toBeGreaterThan(start + 600_000);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when run-now is requested, preserves cadence, reuses eligible work, rejects held work, and consumes one-offs early", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.gen(function* () {
          const job = yield* repo.add(recurring, start);

          const command = {
            action: "run-now" as const,
            id: job.id,
          };

          const receipt = yield* repo.control(command, start);
          expect((yield* repo.task(job.id)).nextAt).toBe(start + 60_000);
          expect(yield* repo.occurrence(receipt.occurrenceId!)).toMatchObject({
            origin: "manual",
            scheduledAt: start,
            availableAt: start,
          });

          const reused = yield* repo.control(command, start + 1);

          expect(reused.occurrenceId).toBe(receipt.occurrenceId);
          yield* repo.cancel(receipt.occurrenceId!, start);
          expect((yield* Effect.flip(repo.control(command, start))).message).toContain(
            "already exists",
          );
          yield* repo.control(
            {
              action: "snooze",
              id: job.id,
              until: start + 120_000,
            },
            start,
          );
          expect((yield* Effect.flip(repo.control(command, start))).message).toContain("held");

          const single = yield* repo.add(
            { ...once, schedule: { type: "once", at: start + 500_000 } },
            start,
          );

          const early = yield* repo.control(
            {
              ...command,
              id: single.id,
            },
            start,
          );

          expect((yield* repo.task(single.id)).nextAt).toBeNull();
          expect(yield* repo.occurrence(early.occurrenceId!)).toMatchObject({
            scheduledAt: start + 500_000,
            availableAt: start,
            origin: "manual",
          });
          expect((yield* repo.claim(start))?.jobId).toBe(single.id);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when the live task changes before retry, uses the historical definition and schedule kind", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.gen(function* () {
          const job = yield* repo.add(once, start);
          yield* repo.reconcile(start);
          const original = (yield* repo.claim(start))!;
          yield* repo.finish(original.id, "failed", "test", start);
          yield* repo.control(
            {
              action: "edit",
              id: job.id,
              patch: { prompt: "Current", schedule: recurring.schedule },
            },
            start,
          );
          yield* repo.retry(original.id, start + 2 * recurringExpiry);
          expect(yield* repo.claim(start + 2 * recurringExpiry)).toMatchObject({
            definition: { prompt: once.prompt, schedule: once.schedule },
            revision: 0,
          });
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when a task destination changes before restart or retry, retains the queued destination", async () => {
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
      const item = await state.run((repo, _store, sql) =>
        Effect.gen(function* () {
          const job = yield* repo.add(once, start, null, destination);
          yield* repo.reconcile(start);
          const queued = (yield* repo.occurrences(job.id))[0]!;
          yield* sql.unsafe("UPDATE jobs SET destination = ? WHERE id = ?", [
            JSON.stringify({ ...destination, conversationId: "other-thread" }),
            job.id,
          ]);

          return queued;
        }),
      );

      await state.run((repo) =>
        Effect.gen(function* () {
          yield* repo.recover(start + 1);
          expect((yield* repo.occurrence(item.id)).destination).toEqual(destination);
          yield* repo.claim(start + 1);
          yield* repo.finish(item.id, "failed", "test", start + 1);
          expect((yield* repo.retry(item.id, start + 2)).destination).toEqual(destination);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when status reports reconnect or quota actions, excludes failure messages and prompts", async () => {
    const state = await fixture();

    try {
      await state.run((repo, store) =>
        Effect.gen(function* () {
          const job = yield* repo.add({ ...once, prompt: "private prompt" }, start);
          yield* repo.reconcile(start);
          const active = (yield* repo.claim(start))!;
          const session = yield* store.createSession("test-provider", "test-model");
          const run = yield* store.queueRun(session.id, [{ role: "user", text: "private prompt" }]);
          yield* store.startRun(run.id);
          yield* store.finishRun(run.id, { status: "failed", reason: "provider:authentication" });
          yield* repo.link(active.id, session.id, run.id);
          yield* repo.finish(active.id, "failed", "private provider diagnostic", start);
          yield* repo.blockProvider("test-provider", "quota", start);
          const overview = yield* repo.status();

          expect(overview).toMatchObject({
            taskCount: 1,
            providers: ["test-provider"],
            pendingCount: 0,
            providerPauses: [
              {
                provider: "test-provider",
                action: "Run tasks resume-provider test-provider when quota is available.",
              },
            ],
            recent: [
              {
                jobId: job.id,
                runId: run.id,
                failureReason: "provider:authentication",
                action: `Run provider login test-provider, then tasks retry ${active.id}.`,
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

  test("when a quota-pause write fails, rolls it back and restores the pause from the saved run after restart", async () => {
    const state = await fixture();

    try {
      const saved = await state.run((repo, store, sql) =>
        Effect.gen(function* () {
          yield* repo.add(once, start);

          const next = yield* repo.add(
            { ...once, schedule: { type: "once", at: start + 1 } },
            start,
          );

          yield* repo.reconcile(start + 1);
          const active = (yield* repo.claim(start + 1))!;
          const session = yield* store.createSession("test-provider", "test-model");
          const queued = yield* store.queueRun(session.id, [{ role: "user", text: once.prompt }]);
          yield* store.startRun(queued.id);
          yield* repo.link(active.id, session.id, queued.id);
          yield* store.finishRun(queued.id, { status: "failed", reason: "provider:quota" });
          yield* sql.unsafe(
            "CREATE TRIGGER reject_pause BEFORE INSERT ON job_provider_pauses BEGIN SELECT RAISE(ABORT, 'Pause write failed'); END",
          );

          expect(
            (yield* Effect.flip(repo.finish(active.id, "failed", "Quota", start + 1, "quota")))
              .message,
          ).toContain("Could not read or update scheduled tasks.");
          expect((yield* repo.occurrence(active.id)).status).toBe("running");
          expect(yield* repo.providers()).toEqual([]);
          yield* sql.unsafe("DROP TRIGGER reject_pause");

          return { occurrence: active.id, run: queued.id, next: next.id };
        }),
      );

      await state.run((repo, store) =>
        Effect.gen(function* () {
          yield* repo.recover(start + 1000);
          expect(yield* repo.providers()).toMatchObject([
            { provider: "test-provider", reason: "quota", resumeAt: null },
          ]);
          expect((yield* repo.occurrence(saved.occurrence)).status).toBe("interrupted");
          expect((yield* store.run(saved.run))?.failureReason).toBe("provider:quota");
          expect(yield* repo.claim(start + 1000)).toBeNull();
          yield* repo.resumeProvider("test-provider", start + 1000);
          yield* repo.recover(start + 2000);
          expect(yield* repo.providers()).toEqual([]);
          expect((yield* repo.claim(start + 2000))?.jobId).toBe(saved.next);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when tasks are cleared, deletes their history while retaining conversations, facts, and provider pauses", async () => {
    const state = await fixture();

    try {
      await state.run((repo, store, sql) =>
        Effect.gen(function* () {
          const single = yield* repo.add(once, start);
          const recurringJob = yield* repo.add(recurring, start);
          yield* repo.reconcile(start + 60_000);
          const active = (yield* repo.claim(start + 60_000))!;
          expect((yield* Effect.flip(repo.clear())).message).toContain("Interrupt active work");
          expect(yield* repo.list()).toHaveLength(2);
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

          yield* repo.link(active.id, session.id, completed.id);
          yield* repo.finish(active.id, "completed", null, start + 60_000);
          yield* sql.unsafe(
            "INSERT INTO memory_revisions (key, revision, action, value, origin, source_run_id, created_at) VALUES ('project', 1, 'remember', 'Acorn', 'turn', ?, ?)",
            [completed.id, start],
          );
          yield* repo.blockProvider("test-provider", "quota", start);
          yield* repo.reconcile(start + 2 * 60_000);
          expect(yield* repo.skips(recurringJob.id)).toHaveLength(1);

          expect(yield* repo.clear()).toBe(2);
          expect(yield* repo.clear()).toBe(0);
          expect(yield* repo.list()).toEqual([]);
          expect(yield* repo.occurrences(single.id)).toEqual([]);
          expect(yield* repo.occurrences(recurringJob.id)).toEqual([]);
          expect(yield* repo.skips(recurringJob.id)).toEqual([]);
          expect(yield* repo.providers()).toMatchObject([
            { provider: "test-provider", reason: "quota" },
          ]);
          expect(yield* store.run(completed.id)).toEqual(completed);
          expect((yield* store.messages(session.id)).map((entry) => entry.message.role)).toEqual([
            "user",
            "assistant",
          ]);

          expect(
            yield* sql`SELECT value, source_run_id FROM memories WHERE key = 'project'`,
          ).toEqual([{ value: "Acorn", sourceRunId: completed.id }]);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when reconciliation fails, rolls back occurrences and schedule advancement together", async () => {
    const state = await fixture();

    try {
      await state.run((repo, _store, sql) =>
        Effect.gen(function* () {
          const first = yield* repo.add(recurring, start);
          const second = yield* repo.add(recurring, start + 1);
          yield* sql.unsafe("UPDATE jobs SET schedule = ? WHERE id = ?", [
            JSON.stringify({ ...recurring.schedule, timezone: "Invalid/Zone" }),
            second.id,
          ]);

          expect((yield* Effect.flip(repo.reconcile(start + 60_000))).message).toContain(
            "Invalid cron",
          );
          expect(yield* repo.occurrences(first.id)).toEqual([]);
          expect((yield* repo.task(first.id)).nextAt).toBe(start + 60_000);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when an answer commits before its task outcome, recovers it without replay", async () => {
    const state = await fixture();

    try {
      const id = await state.run((repo, store) =>
        Effect.gen(function* () {
          yield* repo.add(once, start);
          yield* repo.reconcile(start);
          const active = (yield* repo.claim(start))!;
          const session = yield* store.createSession("test-provider", "test-model");
          const queued = yield* store.queueRun(session.id, [{ role: "user", text: once.prompt }]);
          yield* store.startRun(queued.id);
          yield* repo.link(active.id, session.id, queued.id);
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

          return active.id;
        }),
      );

      await state.run((repo, store) =>
        Effect.gen(function* () {
          yield* repo.reconcile(start + 1000, true);
          const item = yield* repo.occurrence(id);
          expect(item.status).toBe("completed");
          expect((yield* store.run(item.runId!))?.result?.output).toEqual([
            { type: "text", text: "Saved answer" },
          ]);
          expect(yield* repo.claim(start + 1000)).toBeNull();
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when DST changes local time, shifts missing times forward and runs repeated times once", () => {
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

  test("when schedules advance after downtime, commits atomically and runs overdue one-offs once", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.gen(function* () {
          const daily = yield* repo.add(recurring, start);
          const single = yield* repo.add(once, start);
          yield* repo.reconcile(start + 10 * 60_000, true);
          yield* repo.reconcile(start + 10 * 60_000, true);

          expect(yield* repo.occurrences(daily.id)).toEqual([]);
          expect(yield* repo.skips(daily.id)).toEqual([
            { firstAt: start + 60_000, lastAt: start + 10 * 60_000, reason: "downtime" },
          ]);
          expect((yield* repo.task(daily.id)).nextAt).toBe(start + 11 * 60_000);
          expect((yield* repo.task(single.id)).nextAt).toBeNull();
          expect(yield* repo.occurrences(single.id)).toHaveLength(1);

          yield* repo.reconcile(start + 11 * 60_000);
          yield* repo.reconcile(start + 11 * 60_000);
          expect(yield* repo.occurrences(daily.id)).toHaveLength(1);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when recurring work is missed within the catch-up window, runs the latest missed slot once", async () => {
    const state = await fixture(60 * 60_000);

    try {
      await state.run((repo) =>
        Effect.gen(function* () {
          const job = yield* repo.add(morning, start - 60_000);

          // A worker that starts shortly after 09:00 still runs that morning's occurrence.
          yield* repo.reconcile(start + 5 * 60_000, true);
          yield* repo.reconcile(start + 5 * 60_000, true);
          expect((yield* repo.occurrences(job.id)).map((item) => item.scheduledAt)).toEqual([
            start,
          ]);
          expect(yield* repo.skips(job.id)).toEqual([]);
          expect((yield* repo.task(job.id)).nextAt).toBe(start + 24 * 60 * 60_000);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test.each([true, false])(
    "when recurring times exceed the catch-up window with startup=%j, skips them",
    async (startup) => {
      const state = await fixture(60 * 60_000);

      try {
        await state.run((repo) =>
          Effect.gen(function* () {
            const job = yield* repo.add(morning, start - 60_000);
            const late = start + 2 * 60 * 60_000;

            yield* repo.reconcile(late, startup);
            expect(yield* repo.occurrences(job.id)).toEqual([]);
            expect(yield* repo.skips(job.id)).toEqual([
              { firstAt: start, lastAt: late, reason: startup ? "downtime" : "worker-delayed" },
            ]);
            expect((yield* repo.task(job.id)).nextAt).toBe(start + 24 * 60 * 60_000);
          }),
        );
      } finally {
        await state.close();
      }
    },
  );

  test("when a long outage ends, runs only the latest recurring slot and records the rest", async () => {
    const state = await fixture(60 * 60_000);

    try {
      await state.run((repo) =>
        Effect.gen(function* () {
          const job = yield* repo.add(morning, start - 60_000);
          const twoDaysLater = start + 2 * 24 * 60 * 60_000;

          yield* repo.reconcile(twoDaysLater + 10 * 60_000, true);
          expect((yield* repo.occurrences(job.id)).map((item) => item.scheduledAt)).toEqual([
            twoDaysLater,
          ]);
          expect(yield* repo.skips(job.id)).toEqual([
            { firstAt: start, lastAt: twoDaysLater - 1, reason: "downtime" },
          ]);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when work overruns or is paused, skips later occurrences and leaves active work for explicit cancellation", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.gen(function* () {
          const job = yield* repo.add(recurring, start);
          yield* repo.reconcile(start + 60_000);
          const active = yield* repo.claim(start + 60_000);
          expect(active).not.toBeNull();
          yield* repo.reconcile(start + 5 * 60_000);
          expect(yield* repo.occurrences(job.id)).toHaveLength(1);
          expect(yield* repo.skips(job.id)).toEqual([
            {
              firstAt: start + 2 * 60_000,
              lastAt: start + 5 * 60_000,
              reason: "previous-occurrence-active",
            },
          ]);
          yield* repo.pause(job.id, start + 5 * 60_000);
          expect((yield* repo.occurrence(active!.id)).status).toBe("running");
          yield* repo.cancel(active!.id, start + 5 * 60_000);
          yield* repo.finish(active!.id, "interrupted", "cancelled", start + 5 * 60_000);
          expect((yield* repo.occurrence(active!.id)).status).toBe("cancelled");
          yield* repo.resume(job.id, start + 5 * 60_000);
          yield* repo.reconcile(start + 6 * 60_000);
          yield* repo.pause(job.id, start + 6 * 60_000);
          expect((yield* repo.occurrences(job.id)).map((item) => item.status)).toEqual([
            "cancelled",
            "cancelled",
          ]);
          expect(yield* repo.claim(start + 6 * 60_000)).toBeNull();
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when pending and active work survive restart, preserves pending work and interrupts active work for manual retry", async () => {
    const state = await fixture();

    try {
      const saved = await state.run((repo, store) =>
        Effect.gen(function* () {
          const first = yield* repo.add(once, start);

          const second = yield* repo.add(
            { ...once, schedule: { type: "once", at: start + 1 } },
            start,
          );

          yield* repo.reconcile(start + 1);
          const active = (yield* repo.claim(start))!;
          const session = yield* store.createSession("test-provider", "test-model");
          const queued = yield* store.queueRun(session.id, [{ role: "user", text: first.prompt }]);
          const running = yield* store.startRun(queued.id);
          yield* repo.link(active.id, session.id, running.id);

          return {
            active: active.id,
            pending: (yield* repo.occurrences(second.id))[0]!.id,
            run: running.id,
          };
        }),
      );

      await state.run((repo, store) =>
        Effect.gen(function* () {
          yield* repo.reconcile(start + 1000, true);
          expect((yield* repo.occurrence(saved.active)).status).toBe("interrupted");
          expect((yield* repo.occurrence(saved.pending)).status).toBe("pending");
          expect((yield* store.run(saved.run))?.status).toBe("interrupted");
          expect((yield* repo.retry(saved.active, start + 1000)).status).toBe("pending");
          yield* repo.reconcile(start + 1000, true);
          expect(yield* repo.list()).toHaveLength(2);
          expect(
            yield* repo.occurrences((yield* repo.occurrence(saved.active)).jobId),
          ).toHaveLength(1);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when quota is paused, holds one recurring occurrence, expires stale summaries, and retains one-offs", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.gen(function* () {
          const job = yield* repo.add(recurring, start);
          const single = yield* repo.add(once, start);
          const other = yield* repo.add({ ...once, provider: "another-provider" }, start);
          yield* repo.blockProvider("test-provider", "quota", start);
          yield* repo.reconcile(start + 60_000);
          yield* repo.reconcile(start + 5 * 60_000);
          expect(yield* repo.occurrences(job.id)).toHaveLength(1);
          expect((yield* repo.claim(start + 5 * 60_000))?.jobId).toBe(other.id);
          expect(yield* repo.claim(start + 5 * 60_000)).toBeNull();
          yield* repo.resumeProvider("test-provider", start + recurringExpiry + 60_000);
          expect((yield* repo.occurrences(job.id))[0]?.status).toBe("expired");
          expect((yield* repo.occurrences(single.id))[0]?.status).toBe("pending");
          expect((yield* repo.claim(start + recurringExpiry + 60_000))?.jobId).toBe(single.id);
          expect(
            (yield* Effect.flip(
              repo.retry(
                (yield* repo.occurrences(job.id))[0]!.id,
                start + recurringExpiry + 60_000,
              ),
            )).message,
          ).toContain("expired");
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when temporary failures occur, delays future work with bounded backoff without replaying failed occurrences", async () => {
    const state = await fixture();

    try {
      await state.run((repo) =>
        Effect.gen(function* () {
          const first = yield* repo.add(once, start);
          yield* repo.add({ ...once, schedule: { type: "once", at: start + 1 } }, start);
          yield* repo.reconcile(start + 1);
          const active = (yield* repo.claim(start))!;
          yield* repo.finish(active.id, "failed", "temporary", start, "temporary");
          expect(yield* repo.claim(start + 29_999)).toBeNull();
          expect(yield* repo.claim(start + 30_000)).not.toBeNull();
          expect((yield* repo.occurrences(first.id))[0]?.status).toBe("failed");

          for (let attempt = 0; attempt < 10; attempt++)
            yield* repo.blockProvider("test-provider", "rate-limit", start);
          expect((yield* repo.providers())[0]?.resumeAt).toBe(start + 300_000);
        }),
      );
    } finally {
      await state.close();
    }
  });
});
