import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { Store, StoreDatabase, StoreLive, type Run } from "@poppet/store";
import { Effect, Layer, Result } from "effect";

import { monitorTools } from "#src/monitor-tools";
import type { NewTask } from "#src/task-schema";
import { makeTaskStore, type TaskStore } from "#src/task-store";

const start = Date.parse("2026-10-21T09:00:00Z");

const task: NewTask = {
  name: "Release",
  prompt: "Read release.md and report its exact release tag.",
  provider: "test-provider",
  model: "test-model",
  workload: "assistant",
  schedule: { type: "cron", expression: "* * * * *", timezone: "UTC" },
};

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-monitor-"));

  const layer = StoreLive.pipe(
    Layer.provide(
      Layer.succeed(AppConfig, {
        applicationName: "Test",
        dataDirectory: directory,
        provider: "test-provider",
        model: "test-model",
      }),
    ),
  );

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

const record = (
  store: Store["Service"],
  run: Run,
  name: string,
  namespace: string,
  id: string,
  args: string,
  output: string,
) =>
  Effect.gen(function* () {
    const external = namespace === "poppet_monitor" || namespace === "poppet_mcp";

    yield* store.recordToolCalls(
      run.id,
      {
        output: [{ type: "tool-call", callId: id, name, namespace, arguments: args }],
        continuation: { version: 1, provider: run.provider, model: run.model, data: {} },
        finishReason: "tool-calls",
        usage: null,
      },
      external
        ? [
            {
              callId: id,
              serverId: namespace === "poppet_monitor" ? "monitor" : "fixture",
              toolName: name,
            },
          ]
        : [],
    );
    yield* store.startToolCall(run.id, id);
    yield* store.finishToolCall(run.id, id, { status: "completed", output });
  });

const begin = (repo: TaskStore, store: Store["Service"], at: number) =>
  Effect.gen(function* () {
    repo.reconcile(at);
    const active = repo.claim(at)!;
    const session = yield* store.createSession(task.provider, task.model);
    const queued = yield* store.queueRun(session.id, [{ role: "user", text: task.prompt }]);
    const run = yield* store.startRun(queued.id);
    repo.link(active.occurrence.id, session.id, run.id);

    return { run, id: active.occurrence.id };
  });

const source = (store: Store["Service"], run: Run, value = "A") =>
  record(
    store,
    run,
    "fetch_page",
    "poppet_web",
    "source",
    '{"url":"https://example.com/release"}',
    JSON.stringify({ url: "https://example.com/release", text: value, truncated: false }),
  );

const candidate = (store: Store["Service"], run: Run, value: string, id = "observation") =>
  record(
    store,
    run,
    "report_observation",
    "poppet_monitor",
    id,
    JSON.stringify({ value, summary: `Current ${value}: ${id}`, sourceCallIds: ["source"] }),
    '{"accepted":true,"pending":true}',
  );

const complete = (store: Store["Service"], run: Run) =>
  store.finishRun(run.id, {
    status: "completed",
    response: {
      output: [{ type: "text", text: "Final prose is not the notification" }],
      continuation: { version: 1, provider: run.provider, model: run.model, data: {} },
      finishReason: "stop",
      usage: null,
    },
  });

describe.concurrent("monitoring.ts", () => {
  test("when monitor metadata or prompts change, preserves comparisons or starts a quiet baseline without deleting history", async () => {
    const state = await fixture();

    try {
      await state.run((repo, store) =>
        Effect.gen(function* () {
          const job = repo.add(task, start, null, null, undefined, true);
          const first = yield* begin(repo, store, start + 60_000);
          yield* source(store, first.run);
          yield* candidate(store, first.run, "A");
          yield* complete(store, first.run);
          repo.finish(first.id, "completed", null, start + 60_000);
          expect(repo.monitoring.result(first.id)?.decision).toBe("baseline");
          repo.control(
            {
              action: "edit",
              id: job.id,
              revision: 0,
              operationId: "rename",
              patch: {
                name: "Renamed",
                schedule: { type: "cron", expression: "*/2 * * * *", timezone: "UTC" },
              },
            },
            start + 60_000,
          );
          const second = yield* begin(repo, store, start + 120_000);
          yield* source(store, second.run, "B");
          yield* candidate(store, second.run, "B");
          yield* complete(store, second.run);
          repo.finish(second.id, "completed", null, start + 120_000);
          expect(repo.monitoring.result(second.id)).toMatchObject({
            decision: "changed",
            previousValue: "A",
          });

          const reset = repo.control(
            {
              action: "edit",
              id: job.id,
              revision: 1,
              operationId: "prompt",
              patch: { prompt: "Watch a different release source" },
            },
            start + 120_000,
          );

          expect(reset.baselineReset).toBe(true);
          expect(repo.monitoring.latest(job.id, repo.task(job.id).monitorBaselineAfter)).toBeNull();
          expect(repo.monitoring.result(second.id)?.value).toBe("B");
          const third = yield* begin(repo, store, start + 240_000);
          yield* source(store, third.run, "C");
          yield* candidate(store, third.run, "C");
          yield* complete(store, third.run);
          repo.recover(start + 240_001);
          expect(repo.monitoring.result(third.id)).toMatchObject({
            decision: "baseline",
            previousValue: null,
            notificationText: null,
          });
          repo.reconcile(start + 360_000);
          const old = repo.claim(start + 360_000)!;
          repo.finish(old.occurrence.id, "failed", "test", start + 360_000);
          repo.control(
            {
              action: "edit",
              id: job.id,
              revision: 2,
              operationId: "again",
              patch: { prompt: task.prompt },
            },
            start + 360_000,
          );
          expect(() => repo.retry(old.occurrence.id, start + 360_001)).toThrow(
            "predates a prompt change",
          );
          expect(() =>
            repo.control(
              {
                action: "edit",
                id: job.id,
                revision: 3,
                operationId: "once",
                patch: { schedule: { type: "once", at: start + 500_000 } },
              },
              start + 360_000,
            ),
          ).toThrow("recurring");
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when observations change, compares values, records transitions once, and clears projections with tasks", async () => {
    const state = await fixture();

    try {
      await state.run((repo, store, database) =>
        Effect.gen(function* () {
          const job = repo.add(task, start, null, null, undefined, true);
          const decisions: string[] = [];

          for (const [index, value] of ["A", "A", "B", "B", "A", "a"].entries()) {
            const at = start + (index + 1) * 60_000;
            const { run, id } = yield* begin(repo, store, at);
            yield* source(store, run, value);
            yield* candidate(store, run, value, `observation-${index}`);
            yield* complete(store, run);
            repo.finish(id, "completed", null, at);
            const saved = repo.monitoring.result(id)!;
            decisions.push(saved.decision);
            repo.finish(id, "completed", null, at + 1);
            expect(repo.monitoring.result(id)).toEqual(saved);
            expect(saved.notificationText ?? "").not.toContain("Final prose");
          }

          expect(decisions).toEqual([
            "baseline",
            "unchanged",
            "changed",
            "unchanged",
            "changed",
            "changed",
          ]);
          expect(repo.monitoring.latest(job.id)).toMatchObject({ value: "a", previousValue: "A" });
          expect(database.query("SELECT COUNT(*) AS count FROM job_monitor_results").get()).toEqual(
            { count: 6 },
          );
          expect(repo.clear()).toBe(1);
          expect(database.query("SELECT COUNT(*) AS count FROM job_monitor_results").get()).toEqual(
            { count: 0 },
          );
          expect(yield* store.sessions).toHaveLength(6);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test("when projection writes fail, rolls back and recovers the completed journal once after restart", async () => {
    const state = await fixture();

    try {
      const saved = await state.run((repo, store, database) =>
        Effect.gen(function* () {
          const job = repo.add(task, start, null, null, undefined, true);
          const { run, id } = yield* begin(repo, store, start + 60_000);
          yield* source(store, run);
          yield* candidate(store, run, "A");
          yield* complete(store, run);
          database.run(
            "CREATE TRIGGER reject_monitor BEFORE INSERT ON job_monitor_results BEGIN SELECT RAISE(ABORT, 'Projection failed'); END",
          );
          expect(() => repo.finish(id, "completed", null, start + 60_000)).toThrow(
            "Projection failed",
          );
          expect(repo.occurrence(id).status).toBe("running");
          expect(repo.monitoring.latest(job.id)).toBeNull();
          database.run("DROP TRIGGER reject_monitor");

          return { id, jobId: job.id, runId: run.id };
        }),
      );

      await state.run((repo, store) =>
        Effect.gen(function* () {
          repo.recover(start + 61_000);
          const first = repo.monitoring.result(saved.id);
          const journal = yield* store.toolCalls(saved.runId);
          expect(first).toMatchObject({
            decision: "baseline",
            value: "A",
            observedAt: journal.find((call) => call.callId === "observation")!.finishedAt,
          });
          expect(repo.occurrence(saved.id).status).toBe("completed");
          repo.recover(start + 62_000);
          expect(repo.monitoring.latest(saved.jobId)).toEqual(first);
          expect(yield* store.runs((yield* store.run(saved.runId))!.sessionId)).toHaveLength(1);
          repo.pause(saved.jobId, start + 62_000);
          repo.reconcile(start + 9 * 60_000);
          expect(repo.claim(start + 9 * 60_000)).toBeNull();
          repo.resume(saved.jobId, start + 10 * 60_000);
          const resumed = yield* begin(repo, store, start + 11 * 60_000);
          yield* source(store, resumed.run, "B");
          yield* candidate(store, resumed.run, "B");
          yield* complete(store, resumed.run);
          repo.finish(resumed.id, "completed", null, start + 11 * 60_000);
          expect(repo.monitoring.latest(saved.jobId)).toMatchObject({
            previousValue: "A",
            value: "B",
            decision: "changed",
          });
        }),
      );
    } finally {
      await state.close();
    }
  });

  test.each(["missing", "duplicate", "late-source", "failed", "interrupted", "cancelled"])(
    "when a check is %s, preserves its baseline and uses a fresh run for explicit retry",
    async (failure) => {
      const state = await fixture();

      try {
        await state.run((repo, store) =>
          Effect.gen(function* () {
            const job = repo.add(task, start, null, null, undefined, true);
            const first = yield* begin(repo, store, start + 60_000);
            yield* source(store, first.run);
            yield* candidate(store, first.run, "A");
            yield* complete(store, first.run);
            repo.finish(first.id, "completed", null, start + 60_000);
            const next = yield* begin(repo, store, start + 120_000);

            if (failure === "late-source") yield* candidate(store, next.run, "B");
            yield* source(store, next.run, "B");

            if (failure !== "missing" && failure !== "late-source")
              yield* candidate(store, next.run, "B");

            if (failure === "duplicate")
              yield* candidate(store, next.run, "B", "second-observation");

            if (failure === "cancelled") repo.cancel(next.id, start + 120_000);

            if (failure === "failed" || failure === "interrupted")
              yield* store.finishRun(next.run.id, { status: failure, reason: "test" });
            else yield* complete(store, next.run);

            const status =
              failure === "failed" || failure === "interrupted" ? failure : "completed";

            repo.finish(next.id, status, null, start + 120_000);
            expect(repo.monitoring.latest(job.id)?.value).toBe("A");
            expect(repo.monitoring.result(next.id)).toBeNull();
            expect(repo.occurrence(next.id).status).toBe(
              failure === "cancelled" || failure === "interrupted" ? failure : "failed",
            );

            if (["missing", "duplicate", "late-source"].includes(failure))
              expect(repo.status().recent[0]?.failureReason).toBe("monitor:invalid-observation");
            repo.retry(next.id, start + 121_000);
            const retried = yield* begin(repo, store, start + 121_000);
            expect(retried.run.id).not.toBe(next.run.id);
            yield* source(store, retried.run, "C");
            yield* candidate(store, retried.run, "C");
            yield* complete(store, retried.run);
            repo.finish(retried.id, "completed", null, start + 121_000);
            expect(repo.monitoring.result(retried.id)).toMatchObject({
              previousValue: "A",
              value: "C",
              decision: "changed",
            });
          }),
        );
      } finally {
        await state.close();
      }
    },
  );

  test("when monitoring requests observations, offers the tool only to the bound active run and rechecks cancellation", async () => {
    const state = await fixture();

    try {
      await state.run((repo, store) =>
        Effect.gen(function* () {
          expect(() =>
            repo.add(
              { ...task, schedule: { type: "once", at: start } },
              start,
              null,
              null,
              undefined,
              true,
            ),
          ).toThrow("Monitoring requires");
          repo.add(task, start, null, null, undefined, true);
          const { run, id } = yield* begin(repo, store, start + 60_000);
          const binding = { runId: run.id, sessionId: run.sessionId };
          expect(monitorTools(repo, false, binding, 16384)).toEqual([]);
          expect(monitorTools(repo, true, { ...binding, sessionId: "another" }, 16384)).toEqual([]);
          yield* source(store, run);
          const tool = monitorTools(repo, true, binding, 16384)[0]!;

          const prepared = yield* tool.prepare(
            JSON.stringify({ value: "A", summary: "A release", sourceCallIds: ["source"] }),
          );

          expect(JSON.parse(yield* prepared.execute)).toEqual({ accepted: true, pending: true });
          expect(repo.monitoring.latest(repo.occurrence(id).jobId)).toBeNull();
          repo.cancel(id, start + 60_000);
          expect(monitorTools(repo, true, binding, 16384)).toEqual([]);
          expect(Result.isFailure(yield* Effect.result(prepared.execute))).toBe(true);
          yield* store.finishRun(run.id, { status: "interrupted", reason: "cancelled" });
          repo.pause(repo.occurrence(id).jobId, start + 60_000);
          const report = repo.add(task, start + 60_000);
          const ordinary = yield* begin(repo, store, start + 120_000);
          expect(repo.occurrence(ordinary.id).jobId).toBe(report.id);
          expect(
            monitorTools(
              repo,
              true,
              { runId: ordinary.run.id, sessionId: ordinary.run.sessionId },
              16384,
            ),
          ).toEqual([]);
        }),
      );
    } finally {
      await state.close();
    }
  });

  test.each([
    "truncated",
    "empty",
    "foreign-call",
    "recalled",
    "duplicate-id",
    "oversized",
    "extra-field",
    "budget",
    "mcp-omitted",
    "mcp-redacted",
    "valid-page",
    "valid-mcp",
  ])("when evidence is %s, validates it before accepting an observation", async (kind) => {
    const state = await fixture();

    try {
      await state.run((repo, store) =>
        Effect.gen(function* () {
          repo.add(task, start, null, null, undefined, true);
          const { run } = yield* begin(repo, store, start + 60_000);
          const mcp = kind.includes("mcp");

          const output = mcp
            ? {
                content: ["A"],
                structuredContent: null,
                truncated: false,
                omittedContent: kind === "mcp-omitted" ? 1 : 0,
                omittedStructuredContent: false,
                redacted: kind === "mcp-redacted",
              }
            : {
                text: kind === "empty" ? "  " : "A",
                url: "https://example.com/release",
                truncated: kind === "truncated",
              };

          let name = "fetch_page";
          let namespace = "poppet_web";

          if (mcp) {
            name = "read";
            namespace = "poppet_mcp";
          } else if (kind === "recalled") {
            name = "read_session";
            namespace = "poppet_history";
          }

          yield* record(store, run, name, namespace, "source", "{}", JSON.stringify(output));
          let sourceCallIds = ["source"];

          if (kind === "foreign-call") sourceCallIds = ["foreign"];

          if (kind === "duplicate-id") sourceCallIds = ["source", "source"];

          const args = {
            value: kind === "oversized" ? "a".repeat(1025) : "A",
            summary: "Current release",
            sourceCallIds,
          };

          const tool = monitorTools(
            repo,
            true,
            { runId: run.id, sessionId: run.sessionId },
            kind === "budget" ? 32 : 16384,
          )[0]!;

          const prepared = yield* Effect.result(
            tool.prepare(
              JSON.stringify(kind === "extra-field" ? { ...args, taskId: "forged" } : args),
            ),
          );

          expect(Result.isSuccess(prepared)).toBe(kind.startsWith("valid-"));
        }),
      );
    } finally {
      await state.close();
    }
  });
});
