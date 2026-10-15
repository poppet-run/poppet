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

const fixture = async () => {
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

          return yield* body(makeTaskStore(database), store, database);
        }).pipe(Effect.provide(layer)),
      ),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};

describe.concurrent("task schedules", () => {
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
                action: "Run tasks resume-provider test-provider when quota is available.",
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
