import { randomUUID } from "node:crypto";

import { taskCatchUpMinutes } from "@poppet/config";
import {
  DeliveryDestination,
  SkillSnapshot,
  decodeRow,
  decodeRows,
  migrate,
  reportAs,
} from "@poppet/store";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/sql";

import { taskSchema } from "#src/migrations";
import { taskControls } from "#src/task-controls";
import { latestTime, nextTime, taskFailure, taskRecords, recurringExpiry } from "#src/task-records";
import {
  NewTask,
  Occurrence,
  ProviderPause,
  Skipped,
  Task,
  TaskError,
  ControlReceipt,
} from "#src/task-schema";

interface TaskSkip {
  readonly jobId: string;
  readonly name: string;
  readonly firstAt: number;
  readonly lastAt: number;
  readonly reason: "downtime" | "previous-occurrence-active" | "worker-delayed";
}

const Count = Schema.Struct({ count: Schema.Natural });

// Each public operation reports TaskError; internal steps may also fail with SQL or schema errors.
const operation =
  <Args extends ReadonlyArray<unknown>, A, E, R>(run: (...args: Args) => Effect.Effect<A, E, R>) =>
  (...args: Args) =>
    run(...args).pipe(reportAs(taskFailure));

/**
 * Builds task operations on the shared database connection.
 * catchUpMs is how late a missed recurring occurrence may still run once; older ones are
 * skipped. Zero skips missed recurring work at startup; while running, it queues the earliest
 * due occurrence if the task is idle.
 */
export const makeTaskStore = (sql: SqlClient.SqlClient, catchUpMs = 0) => {
  const commandLock = Semaphore.makeUnsafe(1);

  const { tasks, occurrences, task, occurrence, insertOccurrence, activeOccurrence, nextTarget } =
    taskRecords(sql);

  const control = taskControls(sql);

  const list = () => sql`${tasks} ORDER BY created_at, id`.pipe(decodeRows(Task));

  const occurrencesFor = (jobId: string, limit = -1) =>
    sql`${occurrences} WHERE job_id = ${jobId} ORDER BY scheduled_at DESC, id LIMIT ${limit}`.pipe(
      decodeRows(Occurrence),
    );

  // Run the definition saved with the occurrence, not later edits to its task.
  const executionTask = (item: Occurrence) =>
    Effect.map(task(item.jobId), (job): Task => ({
      ...job,
      ...item.definition,
      revision: item.revision,
      destination: item.destination,
    }));

  // Scheduled occurrences are idempotent per task revision and time.
  const queue = (job: Task, scheduledAt: number) =>
    insertOccurrence(job, scheduledAt, { ignoreDuplicate: true });

  const providers = () =>
    sql`SELECT provider, reason, resume_at, failures FROM job_provider_pauses ORDER BY provider`.pipe(
      decodeRows(ProviderPause),
    );

  const hasActive = (jobId: string) =>
    sql`SELECT id FROM job_occurrences WHERE job_id = ${jobId}
      AND status IN ('pending', 'running') LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0));

  const recover = (now: number) =>
    sql.withTransaction(
      Effect.gen(function* () {
        // The run may have saved a quota failure before the occurrence was finalized.
        yield* sql`INSERT INTO job_provider_pauses (provider, reason, resume_at, failures)
          SELECT DISTINCT json_extract(occurrences.definition, '$.provider'), 'quota', NULL, 1
          FROM job_occurrences AS occurrences
          JOIN runs ON runs.id = occurrences.run_id
          WHERE occurrences.status = 'running' AND runs.failure_reason = 'provider:quota'
          ON CONFLICT (provider) DO UPDATE SET reason = 'quota', resume_at = NULL`;

        const running = yield* sql`${occurrences} WHERE status = 'running'`.pipe(
          decodeRows(Occurrence),
        );

        for (const item of running) {
          const completed =
            item.runId !== null &&
            (yield* sql`SELECT id FROM runs WHERE id = ${item.runId} AND status = 'completed'`)
              .length > 0;

          yield* finish(
            item.id,
            completed ? "completed" : "interrupted",
            completed ? null : "owner-stopped",
            now,
          );
        }
      }),
    );

  const expire = (now: number) =>
    sql`UPDATE job_occurrences SET status = 'expired', finished_at = ${now},
      reason = 'summary-expired'
      WHERE status = 'pending' AND available_at <= ${now - recurringExpiry}
        AND json_extract(definition, '$.schedule.type') = 'cron'`;

  /** Queues due work and advances schedules together, recording missed recurring work as skips. */
  const reconcile = (now: number, startup = false) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const skipped: TaskSkip[] = [];

        const recordSkip = (job: Task, firstAt: number, reason: TaskSkip["reason"], lastAt = now) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO job_skips (job_id, first_at, last_at, reason)
              VALUES (${job.id}, ${firstAt}, ${lastAt}, ${reason})`;
            skipped.push({ jobId: job.id, name: job.name, firstAt, lastAt, reason });
          });

        if (startup) yield* recover(now);

        yield* expire(now);

        for (const job of yield* list()) {
          if (job.paused || job.nextAt === null || job.nextAt > now) continue;
          const nextAt = yield* nextTime(job.schedule, now);

          const busy = yield* hasActive(job.id);

          // A historical retry may hold a rearmed one-off; keep its slot until that work finishes.
          if (busy && job.schedule.type === "once") continue;

          const skip = job.schedule.type === "cron" && (startup || busy);
          const missed = startup ? "downtime" : "worker-delayed";

          if (job.schedule.type === "cron" && !busy && catchUpMs > 0) {
            // Run only the most recent missed time, and only while it is still recent.
            const latest = Math.max(
              job.nextAt,
              (yield* latestTime(job.schedule, now)) ?? job.nextAt,
            );

            if (now - latest > catchUpMs) yield* recordSkip(job, job.nextAt, missed);
            else {
              yield* queue(job, latest);

              if (latest > job.nextAt) yield* recordSkip(job, job.nextAt, missed, latest - 1);
            }
          } else if (skip) {
            yield* recordSkip(job, job.nextAt, startup ? "downtime" : "previous-occurrence-active");
          } else {
            yield* queue(job, job.nextAt);

            // A delayed timer enqueues the earliest due occurrence and skips the rest.
            const following = yield* nextTime(job.schedule, job.nextAt);

            if (following !== null && following <= now)
              yield* recordSkip(job, following, "worker-delayed");
          }

          yield* sql`UPDATE jobs SET next_at = ${nextAt} WHERE id = ${job.id}`;
        }

        // Return only committed transitions, so the worker never logs rolled-back skips.
        return skipped;
      }),
    );

  const add = (
    input: NewTask,
    now: number,
    skill: SkillSnapshot | null = null,
    destination: DeliveryDestination | null = null,
    source?: { readonly runId: string; readonly callId: string },
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        // A replayed chat tool call returns the task it already created.
        if (source) {
          const existing = yield* sql`SELECT id FROM jobs
          WHERE source_run_id = ${source.runId} AND source_call_id = ${source.callId}`.pipe(
            decodeRow(Schema.Struct({ id: Task.fields.id })),
          );

          if (existing !== null) return yield* task(existing.id);
        }

        if (destination !== null)
          yield* Schema.decodeUnknownEffect(DeliveryDestination)(destination);
        const valid = yield* Schema.decodeUnknownEffect(NewTask)(input);
        const id = randomUUID();

        yield* sql`INSERT INTO jobs ${sql.insert({
          id,
          name: valid.name,
          prompt: valid.prompt,
          provider: valid.provider,
          model: valid.model,
          workload: valid.workload,
          schedule: JSON.stringify(valid.schedule),
          nextAt:
            valid.schedule.type === "once"
              ? valid.schedule.at
              : yield* nextTime(valid.schedule, now),
          createdAt: now,
          skill: skill === null ? null : JSON.stringify(skill),
          destination: destination === null ? null : JSON.stringify(destination),
          sourceRunId: source?.runId ?? null,
          sourceCallId: source?.callId ?? null,
        })}`;

        return yield* task(id);
      }),
    );

  const pause = (id: string, now: number) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* task(id);
        yield* sql`UPDATE jobs SET paused = 1 WHERE id = ${id}`;
        yield* sql`UPDATE job_occurrences SET status = 'cancelled', finished_at = ${now},
          reason = 'task-paused' WHERE job_id = ${id} AND status = 'pending'`;

        return yield* task(id);
      }),
    );

  const clear = () =>
    sql.withTransaction(
      Effect.gen(function* () {
        const running = yield* sql`SELECT id FROM job_occurrences WHERE status = 'running' LIMIT 1`;

        if (running.length > 0)
          return yield* new TaskError({ message: "Interrupt active work before clearing tasks." });

        // Task history references conversations; deleting it leaves those conversations intact.
        yield* sql`DELETE FROM job_operations`;
        yield* sql`DELETE FROM job_skips`;
        yield* sql`DELETE FROM job_occurrences`;

        return (yield* sql`DELETE FROM jobs RETURNING id`).length;
      }),
    );

  const resume = (id: string, now: number) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const job = yield* task(id);

        if (!job.paused) return job;

        const nextAt =
          job.schedule.type === "once" ? job.nextAt : yield* nextTime(job.schedule, now);

        yield* sql`UPDATE jobs SET paused = 0, next_at = ${nextAt} WHERE id = ${id}`;

        return yield* task(id);
      }),
    );

  const cancel = (id: string, now: number) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const item = yield* occurrence(id);

        if (item.status !== "pending" && item.status !== "running")
          return yield* new TaskError({
            message: "Only pending or running occurrences can be cancelled.",
          });

        yield* sql`UPDATE job_occurrences SET status = 'cancelled', finished_at = ${now},
        reason = 'cancelled' WHERE id = ${id}`;

        return yield* occurrence(id);
      }),
    );

  const retry = (id: string, now: number) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const item = yield* occurrence(id);
        const job = yield* task(item.jobId);

        if (job.paused)
          return yield* new TaskError({
            message: "Resume the task before retrying an occurrence.",
          });

        if (!["failed", "interrupted", "cancelled", "expired"].includes(item.status))
          return yield* new TaskError({ message: "Only unsuccessful occurrences can be retried." });

        if (yield* hasActive(job.id))
          return yield* new TaskError({ message: "The task already has an active occurrence." });

        if (item.definition.schedule.type === "cron" && item.availableAt <= now - recurringExpiry)
          return yield* new TaskError({
            message: "This summary expired. Add a new one-off task instead.",
          });

        yield* sql`UPDATE job_occurrences SET status = 'pending', session_id = NULL,
          run_id = NULL, finished_at = NULL, reason = NULL WHERE id = ${id}`;

        return yield* occurrence(id);
      }),
    );

  /** Atomically starts the oldest eligible occurrence, respecting task and provider pauses. */
  const claim = (now: number) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* expire(now);

        const item = yield* sql`${occurrences} WHERE status = 'pending' AND available_at <= ${now}
          AND job_id IN (SELECT id FROM jobs WHERE paused = 0)
          AND json_extract(definition, '$.provider') NOT IN
            (SELECT provider FROM job_provider_pauses WHERE resume_at IS NULL OR resume_at > ${now})
          ORDER BY available_at, scheduled_at, id LIMIT 1`.pipe(decodeRow(Occurrence));

        if (item === null) return null;

        yield* sql`UPDATE job_occurrences SET status = 'running' WHERE id = ${item.id}`;

        return { occurrence: yield* occurrence(item.id), task: yield* executionTask(item) };
      }),
    );

  const link = (id: string, sessionId: string, runId: string | null) =>
    sql`UPDATE job_occurrences SET session_id = ${sessionId}, run_id = ${runId} WHERE id = ${id}`;

  const finish = (
    id: string,
    status: "completed" | "failed" | "interrupted",
    reason: string | null,
    now: number,
    pauseReason: ProviderPause["reason"] | null = null,
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        // Explicit cancellation wins over the run's cleanup callback.
        yield* sql`UPDATE job_occurrences SET status = ${status}, reason = ${reason},
          finished_at = ${now} WHERE id = ${id} AND status = 'running'`;

        const saved = yield* occurrence(id);
        const provider = saved.definition.provider;

        const providerPause =
          pauseReason === null ? null : yield* blockProvider(provider, pauseReason, now);

        const providerResumed = status === "completed" && (yield* resumeProvider(provider, now));

        return { occurrence: saved, pause: providerPause, providerResumed };
      }),
    );

  // Quota failures need manual resumption; transient failures delay future work with capped backoff.
  const blockProvider = (
    provider: string,
    reason: "quota" | "temporary" | "rate-limit",
    now: number,
  ) =>
    Effect.gen(function* () {
      const previous = (yield* providers()).find((item) => item.provider === provider);
      const failures = Math.min((previous?.failures ?? 0) + 1, 5);

      const resumeAt =
        reason === "quota" ? null : now + Math.min(30_000 * 2 ** (failures - 1), 300_000);

      yield* sql`INSERT INTO job_provider_pauses ${sql.insert({ provider, reason, resumeAt, failures })}
        ON CONFLICT (provider) DO UPDATE SET reason = excluded.reason,
          resume_at = excluded.resume_at, failures = excluded.failures`;

      return { provider, reason, resumeAt, failures };
    });

  const resumeProvider = (provider: string, now: number) =>
    Effect.gen(function* () {
      yield* expire(now);

      const removed = yield* sql`DELETE FROM job_provider_pauses WHERE provider = ${provider}
        RETURNING provider`;

      return removed.length > 0;
    });

  const skips = (jobId: string) =>
    sql`SELECT first_at, last_at, reason FROM job_skips WHERE job_id = ${jobId}
      ORDER BY id DESC`.pipe(decodeRows(Skipped));

  const status = () =>
    Effect.gen(function* () {
      const jobs = yield* list();

      const pending = yield* sql`SELECT COUNT(*) AS count FROM job_occurrences
        WHERE status = 'pending'`.pipe(decodeRow(Count));

      const results = yield* sql`SELECT occurrences.id, jobs.id AS job_id,
          json_extract(occurrences.definition, '$.provider') AS provider,
          json_extract(occurrences.definition, '$.name') AS name, occurrences.status,
          occurrences.scheduled_at, occurrences.run_id, runs.failure_reason
        FROM job_occurrences AS occurrences JOIN jobs ON jobs.id = occurrences.job_id
        LEFT JOIN runs ON runs.id = occurrences.run_id
        ORDER BY COALESCE(occurrences.finished_at, occurrences.scheduled_at) DESC,
          occurrences.id DESC LIMIT 5`.pipe(
        decodeRows(
          Schema.Struct({
            id: Occurrence.fields.id,
            jobId: Occurrence.fields.jobId,
            provider: NewTask.fields.provider,
            name: NewTask.fields.name,
            status: Occurrence.fields.status,
            scheduledAt: Schema.Natural,
            runId: Occurrence.fields.runId,
            failureReason: Schema.NullOr(Schema.String),
          }),
        ),
      );

      const upcoming: number[] = [];

      for (const job of jobs) {
        if (job.paused) continue;
        const queued = yield* activeOccurrence(job.id, "pending");

        if (queued !== null) upcoming.push(queued.availableAt);
        else if (job.nextAt !== null && !(yield* hasActive(job.id))) upcoming.push(job.nextAt);
      }

      return {
        taskCount: jobs.length,
        providers: [...new Set(jobs.map((job) => job.provider))],
        pausedTaskCount: jobs.filter((job) => job.paused).length,
        pendingCount: pending?.count ?? 0,
        nextScheduledAt: upcoming.length === 0 ? null : Math.min(...upcoming),
        providerPauses: (yield* providers()).map((held) =>
          Object.assign(held, {
            action:
              held.resumeAt === null
                ? `Run worker resume-provider ${held.provider} when quota is available.`
                : `Future work can resume at ${new Date(held.resumeAt).toISOString()}.`,
          }),
        ),
        recent: results.map((item) =>
          Object.assign(item, {
            action:
              item.failureReason === "provider:authentication"
                ? `Run provider login ${item.provider}, then tasks retry ${item.id}.`
                : item.status === "interrupted"
                  ? `Run tasks retry ${item.id} if this work should run again.`
                  : item.status === "failed"
                    ? `Run tasks show ${item.jobId} to inspect the failure before retrying.`
                    : null,
          }),
        ),
      };
    });

  const listPage = (after: string | null) =>
    Effect.gen(function* () {
      if (after !== null) yield* task(after);

      return yield* sql`${tasks} WHERE id > ${after ?? ""} ORDER BY id LIMIT 11`.pipe(
        decodeRows(Task),
      );
    });

  const changes = (id: string, limit = 20) =>
    sql`SELECT operation_id, receipt, changes, created_at FROM job_operations
      WHERE job_id = ${id} AND changes IS NOT NULL
      ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`.pipe(
      decodeRows(
        Schema.Struct({
          operationId: Schema.String,
          receipt: Schema.fromJsonString(ControlReceipt),
          changes: Schema.fromJsonString(Schema.Json),
          createdAt: Schema.Natural,
        }),
      ),
    );

  return {
    commandLock,
    list: operation(list),
    listPage: operation(listPage),
    status: operation(status),
    task: operation(task),
    occurrence: operation(occurrence),
    occurrences: operation(occurrencesFor),
    nextTarget: operation(nextTarget),
    control: operation(control),
    changes: operation(changes),
    providers: operation(providers),
    skips: operation(skips),
    add: operation(add),
    reconcile: operation(reconcile),
    recover: operation(recover),
    pause: operation(pause),
    clear: operation(clear),
    resume: operation(resume),
    cancel: operation(cancel),
    retry: operation(retry),
    claim: operation(claim),
    link: operation(link),
    finish: operation(finish),
    blockProvider: operation(blockProvider),
    resumeProvider: operation(resumeProvider),
  };
};

export type TaskStore = ReturnType<typeof makeTaskStore>;

/** Task definitions, occurrence state, and provider pauses stored alongside conversation history. */
export class TaskRepository extends Context.Service<TaskRepository, TaskStore>()(
  "poppet/TaskRepository",
) {}

export const TaskRepositoryLive = Layer.effect(
  TaskRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const minutes = yield* taskCatchUpMinutes;
    yield* migrate(taskSchema);

    return makeTaskStore(sql, minutes * 60_000);
  }),
);
