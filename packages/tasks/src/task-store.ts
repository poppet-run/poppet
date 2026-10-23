import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { taskCatchUpMinutes } from "@poppet/config";
import { DeliveryDestination, StoreDatabase, SkillSnapshot } from "@poppet/store";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";

import { taskControls } from "#src/task-controls";
import { taskRecords, taskSql, occurrenceSql, recurringExpiry } from "#src/task-records";
import {
  NewTask,
  Occurrence,
  ProviderPause,
  Skipped,
  Task,
  TaskError,
  ControlReceipt,
  latestOccurrence,
  nextOccurrence,
} from "#src/task-schema";

interface TaskSkip {
  readonly jobId: string;
  readonly name: string;
  readonly firstAt: number;
  readonly lastAt: number;
  readonly reason: "downtime" | "previous-occurrence-active" | "worker-delayed";
}

/** Builds synchronous task operations on the caller's owned database; failures are thrown. */
/**
 * catchUpMs is how late a missed recurring occurrence may still run once; older ones are
 * skipped. Zero skips missed recurring work at startup; while running, it queues the earliest
 * due occurrence if the task is idle.
 */
export const makeTaskStore = (database: Database, catchUpMs = 0) => {
  const commandLock = Semaphore.makeUnsafe(1);

  const { task, occurrence, insertOccurrence, activeOccurrence, nextTarget } =
    taskRecords(database);

  const control = taskControls(database);

  const list = () => {
    using statement = database.prepare(`${taskSql} ORDER BY created_at, id`);

    return Schema.decodeUnknownSync(Schema.Array(Task))(statement.all());
  };

  const occurrences = (jobId: string, limit = -1) => {
    using statement = database.prepare(
      `${occurrenceSql} WHERE job_id = ? ORDER BY scheduled_at DESC, id LIMIT ?`,
    );

    return Schema.decodeUnknownSync(Schema.Array(Occurrence))(statement.all(jobId, limit));
  };

  const executionTask = (item: Occurrence): Task => ({
    ...task(item.jobId),
    ...item.definition,
    revision: item.revision,
    destination: item.destination,
  });

  // Scheduled occurrences are idempotent per task revision and time.
  const queue = (job: Task, scheduledAt: number) =>
    insertOccurrence(job, scheduledAt, { ignoreDuplicate: true });

  const providers = () => {
    using statement = database.prepare(
      `SELECT provider, reason, resume_at AS resumeAt, failures FROM job_provider_pauses ORDER BY provider`,
    );

    return Schema.decodeUnknownSync(Schema.Array(ProviderPause))(statement.all());
  };

  const hasActive = (jobId: string) => {
    using statement = database.prepare(
      "SELECT id FROM job_occurrences WHERE job_id = ? AND status IN ('pending', 'running') LIMIT 1",
    );

    return statement.get(jobId) !== null;
  };

  const recover = (now: number) =>
    database
      .transaction(() => {
        // The run may have saved a quota failure before the occurrence was finalized.
        database.run(`INSERT INTO job_provider_pauses (provider, reason, resume_at, failures)
      SELECT DISTINCT json_extract(occurrences.definition, '$.provider'), 'quota', NULL, 1
      FROM job_occurrences AS occurrences
      JOIN jobs ON jobs.id = occurrences.job_id
      JOIN runs ON runs.id = occurrences.run_id
      WHERE occurrences.status = 'running' AND runs.failure_reason = 'provider:quota'
      ON CONFLICT (provider) DO UPDATE SET reason = 'quota', resume_at = NULL`);

        const running = Schema.decodeUnknownSync(Schema.Array(Occurrence))(
          database.query(`${occurrenceSql} WHERE status = 'running'`).all(),
        );

        for (const item of running) {
          const completed =
            item.runId !== null &&
            database
              .query("SELECT id FROM runs WHERE id = ? AND status = 'completed'")
              .get(item.runId) !== null;

          finish(
            item.id,
            completed ? "completed" : "interrupted",
            completed ? null : "owner-stopped",
            now,
          );
        }
      })
      .immediate();

  const expire = (now: number) => {
    using statement =
      database.prepare(`UPDATE job_occurrences SET status = 'expired', finished_at = ?, reason = 'summary-expired'
      WHERE status = 'pending' AND available_at <= ? AND json_extract(definition, '$.schedule.type') = 'cron'`);

    statement.run(now, now - recurringExpiry);
  };

  /** Queues due work and advances schedules together, recording missed recurring work as skips. */
  const reconcile = (now: number, startup = false) =>
    database
      .transaction(() => {
        const skipped: TaskSkip[] = [];

        const recordSkip = (
          job: Task,
          firstAt: number,
          reason: TaskSkip["reason"],
          lastAt = now,
        ) => {
          using statement = database.prepare(
            "INSERT INTO job_skips (job_id, first_at, last_at, reason) VALUES (?, ?, ?, ?)",
          );

          statement.run(job.id, firstAt, lastAt, reason);
          skipped.push({ jobId: job.id, name: job.name, firstAt, lastAt, reason });
        };

        if (startup) recover(now);

        expire(now);

        for (const job of list()) {
          if (job.paused || job.nextAt === null || job.nextAt > now) continue;
          const nextAt = nextOccurrence(job.schedule, now);

          const busy = hasActive(job.id);

          // A historical retry may hold a rearmed one-off; keep its slot until that work finishes.
          if (busy && job.schedule.type === "once") continue;

          const skip = job.schedule.type === "cron" && (startup || busy);
          const missed = startup ? "downtime" : "worker-delayed";

          if (job.schedule.type === "cron" && !busy && catchUpMs > 0) {
            // Run only the most recent missed time, and only while it is still recent.
            const latest = Math.max(job.nextAt, latestOccurrence(job.schedule, now) ?? job.nextAt);

            if (now - latest > catchUpMs) recordSkip(job, job.nextAt, missed);
            else {
              queue(job, latest);

              if (latest > job.nextAt) recordSkip(job, job.nextAt, missed, latest - 1);
            }
          } else if (skip) {
            recordSkip(job, job.nextAt, startup ? "downtime" : "previous-occurrence-active");
          } else {
            queue(job, job.nextAt);

            // A delayed timer enqueues the earliest due occurrence and skips the rest.
            const following = nextOccurrence(job.schedule, job.nextAt);

            if (following !== null && following <= now) {
              recordSkip(job, following, "worker-delayed");
            }
          }

          using update = database.prepare("UPDATE jobs SET next_at = ? WHERE id = ?");

          update.run(nextAt, job.id);
        }

        // Return only committed transitions, so the worker never logs rolled-back skips.
        return skipped;
      })
      .immediate();

  const add = (
    input: NewTask,
    now: number,
    skill: SkillSnapshot | null = null,
    destination: DeliveryDestination | null = null,
    source?: { readonly runId: string; readonly callId: string },
  ) => {
    if (source) {
      const existing = Schema.decodeUnknownSync(
        Schema.NullOr(Schema.Struct({ id: Task.fields.id })),
      )(
        database
          .query("SELECT id FROM jobs WHERE source_run_id = ? AND source_call_id = ?")
          .get(source.runId, source.callId),
      );

      if (existing !== null) return task(existing.id);
    }

    if (destination !== null) Schema.decodeUnknownSync(DeliveryDestination)(destination);
    const valid = Schema.decodeUnknownSync(NewTask)(input);

    const nextAt =
      valid.schedule.type === "once" ? valid.schedule.at : nextOccurrence(valid.schedule, now);

    const id = randomUUID();

    using statement = database.prepare(
      "INSERT INTO jobs (id, name, prompt, provider, model, workload, schedule, next_at, created_at, skill, destination, source_run_id, source_call_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );

    statement.run(
      id,
      valid.name,
      valid.prompt,
      valid.provider,
      valid.model,
      valid.workload,
      JSON.stringify(valid.schedule),
      nextAt,
      now,
      skill === null ? null : Schema.encodeSync(Schema.fromJsonString(SkillSnapshot))(skill),
      destination === null ? null : JSON.stringify(destination),
      source?.runId ?? null,
      source?.callId ?? null,
    );

    return task(id);
  };

  const pause = (id: string, now: number) =>
    database
      .transaction(() => {
        task(id);
        database.run("UPDATE jobs SET paused = 1 WHERE id = ?", [id]);
        database.run(
          "UPDATE job_occurrences SET status = 'cancelled', finished_at = ?, reason = 'task-paused' WHERE job_id = ? AND status = 'pending'",
          [now, id],
        );

        return task(id);
      })
      .immediate();

  const clear = () =>
    database
      .transaction(() => {
        using running = database.prepare(
          "SELECT id FROM job_occurrences WHERE status = 'running' LIMIT 1",
        );

        if (running.get() !== null)
          throw new TaskError({ message: "Interrupt active work before clearing tasks." });

        // Task history references conversations; deleting it leaves those conversations intact.
        database.run("DELETE FROM job_operations");
        database.run("DELETE FROM job_skips");
        database.run("DELETE FROM job_occurrences");

        return database.run("DELETE FROM jobs").changes;
      })
      .immediate();

  const resume = (id: string, now: number) =>
    database
      .transaction(() => {
        const job = task(id);

        if (!job.paused) return job;

        const nextAt =
          job.schedule.type === "once" ? job.nextAt : nextOccurrence(job.schedule, now);

        database.run("UPDATE jobs SET paused = 0, next_at = ? WHERE id = ?", [nextAt, id]);

        return task(id);
      })
      .immediate();

  const cancel = (id: string, now: number) => {
    const item = occurrence(id);

    if (item.status !== "pending" && item.status !== "running")
      throw new TaskError({ message: "Only pending or running occurrences can be cancelled." });
    database.run(
      "UPDATE job_occurrences SET status = 'cancelled', finished_at = ?, reason = 'cancelled' WHERE id = ?",
      [now, id],
    );

    return occurrence(id);
  };

  const retry = (id: string, now: number) =>
    database
      .transaction(() => {
        const item = occurrence(id);
        const job = task(item.jobId);

        if (job.paused)
          throw new TaskError({ message: "Resume the task before retrying an occurrence." });

        if (!["failed", "interrupted", "cancelled", "expired"].includes(item.status))
          throw new TaskError({ message: "Only unsuccessful occurrences can be retried." });

        if (hasActive(job.id))
          throw new TaskError({ message: "The task already has an active occurrence." });

        if (item.definition.schedule.type === "cron" && item.availableAt <= now - recurringExpiry)
          throw new TaskError({ message: "This summary expired. Add a new one-off task instead." });

        database.run(
          "UPDATE job_occurrences SET status = 'pending', session_id = NULL, run_id = NULL, finished_at = NULL, reason = NULL WHERE id = ?",
          [id],
        );

        return occurrence(id);
      })
      .immediate();

  /** Atomically starts the oldest eligible occurrence, respecting task and provider pauses. */
  const claim = (now: number) =>
    database
      .transaction(() => {
        expire(now);

        using statement =
          database.prepare(`${occurrenceSql} WHERE status = 'pending' AND available_at <= ?
      AND job_id IN (SELECT id FROM jobs WHERE paused = 0)
      AND json_extract(definition, '$.provider') NOT IN
        (SELECT provider FROM job_provider_pauses WHERE resume_at IS NULL OR resume_at > ?)
      ORDER BY available_at, scheduled_at, id LIMIT 1`);

        const row = statement.get(now, now);

        if (!row) return null;
        const item = Schema.decodeUnknownSync(Occurrence)(row);
        database.run("UPDATE job_occurrences SET status = 'running' WHERE id = ?", [item.id]);

        return { occurrence: occurrence(item.id), task: executionTask(item) };
      })
      .immediate();

  const link = (id: string, sessionId: string, runId: string | null) => {
    database.run("UPDATE job_occurrences SET session_id = ?, run_id = ? WHERE id = ?", [
      sessionId,
      runId,
      id,
    ]);
  };

  const finish = (
    id: string,
    status: "completed" | "failed" | "interrupted",
    reason: string | null,
    now: number,
    pauseReason: ProviderPause["reason"] | null = null,
  ) =>
    database
      .transaction(() => {
        // Explicit cancellation wins over the run's cleanup callback.
        database.run(
          "UPDATE job_occurrences SET status = ?, reason = ?, finished_at = ? WHERE id = ? AND status = 'running'",
          [status, reason, now, id],
        );

        const saved = occurrence(id);
        const provider = saved.definition.provider;

        const providerPause =
          pauseReason === null ? null : blockProvider(provider, pauseReason, now);

        const providerResumed = status === "completed" && resumeProvider(provider, now);

        return { occurrence: saved, pause: providerPause, providerResumed };
      })
      .immediate();

  // Quota failures need manual resumption; transient failures delay future work with capped backoff.
  const blockProvider = (
    provider: string,
    reason: "quota" | "temporary" | "rate-limit",
    now: number,
  ) => {
    const failures = Math.min(
      (providers().find((item) => item.provider === provider)?.failures ?? 0) + 1,
      5,
    );

    const resumeAt =
      reason === "quota" ? null : now + Math.min(30_000 * 2 ** (failures - 1), 300_000);

    database.run(
      `INSERT INTO job_provider_pauses (provider, reason, resume_at, failures) VALUES (?, ?, ?, ?)
      ON CONFLICT (provider) DO UPDATE SET reason = excluded.reason, resume_at = excluded.resume_at, failures = excluded.failures`,
      [provider, reason, resumeAt, failures],
    );

    return { provider, reason, resumeAt, failures };
  };

  const resumeProvider = (provider: string, now: number) => {
    expire(now);

    return (
      database.run("DELETE FROM job_provider_pauses WHERE provider = ?", [provider]).changes > 0
    );
  };

  const skips = (jobId: string) => {
    using statement = database.prepare(
      "SELECT first_at AS firstAt, last_at AS lastAt, reason FROM job_skips WHERE job_id = ? ORDER BY id DESC",
    );

    return Schema.decodeUnknownSync(Schema.Array(Skipped))(statement.all(jobId));
  };

  const status = () => {
    const jobs = list();

    using pending = database.prepare(
      "SELECT COUNT(*) AS count FROM job_occurrences WHERE status = 'pending'",
    );

    using recent =
      database.prepare(`SELECT occurrences.id, jobs.id AS jobId, json_extract(occurrences.definition, '$.provider') AS provider,
      json_extract(occurrences.definition, '$.name') AS name, occurrences.status,
      occurrences.scheduled_at AS scheduledAt, occurrences.run_id AS runId,
      runs.failure_reason AS failureReason
      FROM job_occurrences AS occurrences JOIN jobs ON jobs.id = occurrences.job_id
      LEFT JOIN runs ON runs.id = occurrences.run_id
      ORDER BY COALESCE(occurrences.finished_at, occurrences.scheduled_at) DESC, occurrences.id DESC LIMIT 5`);

    const upcoming = jobs
      .filter((job) => !job.paused)
      .flatMap((job) => {
        const queued = activeOccurrence(job.id, "pending");

        return queued !== undefined
          ? [queued.availableAt]
          : hasActive(job.id) || job.nextAt === null
            ? []
            : [job.nextAt];
      });

    const results = Schema.decodeUnknownSync(
      Schema.Array(
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
    )(recent.all());

    return {
      taskCount: jobs.length,
      providers: [...new Set(jobs.map((job) => job.provider))],
      pausedTaskCount: jobs.filter((job) => job.paused).length,
      pendingCount: Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Natural }))(
        pending.get(),
      ).count,
      nextScheduledAt: upcoming.length === 0 ? null : Math.min(...upcoming),
      providerPauses: providers().map((held) =>
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
  };

  return {
    commandLock,
    list,
    listPage: (after: string | null) => {
      if (after !== null) task(after);

      return Schema.decodeUnknownSync(Schema.Array(Task))(
        database.query(`${taskSql} WHERE id > ? ORDER BY id LIMIT 11`).all(after ?? ""),
      );
    },
    status,
    task,
    occurrence,
    occurrences,
    nextTarget,
    control,
    changes: (id: string, limit = 20) =>
      Schema.decodeUnknownSync(
        Schema.Array(
          Schema.Struct({
            operationId: Schema.String,
            receipt: Schema.fromJsonString(ControlReceipt),
            changes: Schema.fromJsonString(Schema.Json),
            createdAt: Schema.Natural,
          }),
        ),
      )(
        database
          .query(`SELECT operation_id AS operationId, receipt, changes, created_at AS createdAt
      FROM job_operations WHERE job_id = ? AND changes IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT ?`)
          .all(id, limit),
      ),
    deliveries: (id: string) =>
      Schema.decodeUnknownSync(
        Schema.Array(
          Schema.Struct({
            runId: Schema.String,
            position: Schema.Natural,
            state: Schema.Literals(["pending", "sending", "sent", "failed", "uncertain"]),
            messageId: Schema.NullOr(Schema.String),
            attempts: Schema.Natural,
          }),
        ),
      )(
        database
          .query(`SELECT i.run_id AS runId, d.position, d.state, d.message_id AS messageId, d.attempts
      FROM gateway_deliveries d JOIN gateway_inbox i ON i.id = d.inbox_id
      WHERE i.occurrence_id = ? ORDER BY i.id, d.position`)
          .all(id),
      ),
    providers,
    skips,
    add,
    reconcile,
    recover,
    pause,
    clear,
    resume,
    cancel,
    retry,
    claim,
    link,
    finish,
    blockProvider,
    resumeProvider,
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
    const { database } = yield* StoreDatabase;
    const minutes = yield* taskCatchUpMinutes;

    return makeTaskStore(database, minutes * 60_000);
  }),
);
