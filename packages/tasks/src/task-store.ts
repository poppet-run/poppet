import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { taskCatchUpMinutes } from "@poppet/config";
import { DeliveryDestination, StoreDatabase, SkillSnapshot, ProjectSnapshot } from "@poppet/store";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";

import { monitoringRecords } from "#src/monitoring";
import {
  NewTask,
  Occurrence,
  ProviderPause,
  Skipped,
  Task,
  TaskError,
  TaskControl,
  ControlReceipt,
  TaskDefinition,
  type TaskTarget,
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

// Recurring summaries lose their usefulness after a day. One-off work never expires.
export const recurringExpiry = 24 * 60 * 60 * 1000;

const taskSql = `SELECT id, name, prompt, provider, model, workload, schedule,
  monitor, revision, monitor_revision AS monitorRevision, monitor_baseline_after AS monitorBaselineAfter,
  skill, project, destination, next_at AS nextAt, paused, created_at AS createdAt FROM jobs`;

const occurrenceSql = `SELECT id, job_id AS jobId, scheduled_at AS scheduledAt, status,
  revision, definition, available_at AS availableAt, origin,
  destination, session_id AS sessionId, run_id AS runId, finished_at AS finishedAt, reason FROM job_occurrences`;

/** Builds synchronous task operations on the caller's owned database; failures are thrown. */
/**
 * catchUpMs is how late a missed recurring occurrence may still run once; older ones are
 * skipped. Zero keeps the original policy of skipping at startup and running late otherwise.
 */
export const makeTaskStore = (database: Database, catchUpMs = 0) => {
  const commandLock = Semaphore.makeUnsafe(1);
  const monitoring = monitoringRecords(database);

  const list = () => {
    using statement = database.prepare(`${taskSql} ORDER BY created_at, id`);

    return Schema.decodeUnknownSync(Schema.Array(Task))(statement.all());
  };

  const task = (id: string) => {
    using statement = database.prepare(`${taskSql} WHERE id = ?`);
    const row = statement.get(id);

    if (!row) throw new TaskError({ message: "The task does not exist. Use tasks list." });

    return Schema.decodeUnknownSync(Task)(row);
  };

  const occurrence = (id: string) => {
    using statement = database.prepare(`${occurrenceSql} WHERE id = ?`);
    const row = statement.get(id);

    if (!row)
      throw new TaskError({ message: "The occurrence does not exist. Use tasks show <task>." });

    return Schema.decodeUnknownSync(Occurrence)(row);
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

  const insertOccurrence = (
    job: Task,
    scheduledAt: number,
    options: {
      readonly availableAt?: number;
      readonly status?: Occurrence["status"];
      readonly reason?: string | null;
      readonly finishedAt?: number | null;
      readonly origin?: Occurrence["origin"];
      readonly destination?: Task["destination"];
      readonly ignoreDuplicate?: boolean;
    } = {},
  ) => {
    const {
      availableAt = scheduledAt,
      status = "pending",
      reason = null,
      finishedAt = null,
      origin = "scheduled",
      destination = job.destination,
      ignoreDuplicate = false,
    } = options;

    const id = randomUUID();
    const definition = Schema.decodeUnknownSync(TaskDefinition)(job);
    database
      .query(`INSERT INTO job_occurrences
        (id, job_id, revision, definition, scheduled_at, available_at, status, reason, finished_at, origin, destination)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${ignoreDuplicate ? "ON CONFLICT (job_id, revision, scheduled_at) DO NOTHING" : ""}`)
      .run(
        id,
        job.id,
        job.revision,
        JSON.stringify(definition),
        scheduledAt,
        availableAt,
        status,
        reason,
        finishedAt,
        origin,
        destination === null ? null : JSON.stringify(destination),
      );

    return id;
  };

  // Scheduled occurrences are idempotent per task revision and time.
  const queue = (job: Task, scheduledAt: number) =>
    insertOccurrence(job, scheduledAt, { ignoreDuplicate: true });

  const activeOccurrence = (id: string, status: "pending" | "running") => {
    const row = database
      .query(`${occurrenceSql} WHERE job_id = ? AND status = ? LIMIT 1`)
      .get(id, status);

    return row === null ? undefined : Schema.decodeUnknownSync(Occurrence)(row);
  };

  const nextTarget = (id: string): TaskTarget | null => {
    const job = task(id);
    const pending = activeOccurrence(id, "pending");

    if (pending !== undefined)
      return {
        occurrenceId: pending.id,
        scheduledAt: pending.scheduledAt,
        availableAt: pending.availableAt,
      };

    return job.nextAt === null
      ? null
      : { occurrenceId: null, scheduledAt: job.nextAt, availableAt: job.nextAt };
  };

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

        // Monitoring recovery uses the same comparison and validation as normal completion.
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
    monitor = false,
    project: ProjectSnapshot | null = null,
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

    if (monitor && valid.schedule.type !== "cron")
      throw new TaskError({ message: "Monitoring requires --cron and an explicit timezone." });

    const nextAt =
      valid.schedule.type === "once" ? valid.schedule.at : nextOccurrence(valid.schedule, now);

    const id = randomUUID();

    using statement = database.prepare(
      "INSERT INTO jobs (id, name, prompt, provider, model, workload, schedule, next_at, created_at, skill, destination, source_run_id, source_call_id, monitor, project) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
      monitor ? 1 : 0,
      project === null ? null : Schema.encodeSync(Schema.fromJsonString(ProjectSnapshot))(project),
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

  /** Revision/target checks, state changes, history and replay receipts share one transaction. */
  const control = (input: TaskControl, now: number) =>
    database
      .transaction(() => {
        const command = Schema.decodeUnknownSync(TaskControl, { onExcessProperty: "error" })(input);

        const saved = Schema.decodeUnknownSync(
          Schema.NullOr(
            Schema.Struct({
              command: Schema.fromJsonString(Schema.Json),
              receipt: Schema.fromJsonString(ControlReceipt),
            }),
          ),
        )(
          database
            .query("SELECT command, receipt FROM job_operations WHERE operation_id = ?")
            .get(command.operationId),
        );

        if (saved !== null) {
          if (!isDeepStrictEqual(saved.command, command))
            throw new TaskError({
              message: "The operation ID belongs to a different task request.",
            });

          return saved.receipt;
        }

        const job = task(command.id);

        if (job.revision !== command.revision)
          throw new TaskError({
            message: "The task definition changed. Inspect it again before changing it.",
          });
        const active = activeOccurrence(job.id, "running");

        if (active !== undefined)
          throw new TaskError({
            message: "Cancel the running occurrence before changing this task.",
          });

        const pending = activeOccurrence(job.id, "pending");
        let selected: Occurrence | null = null;
        let replacedOccurrenceIds: string[] = [];
        let changedFields: string[] = [];
        let baselineReset = false;
        let snoozeCleared = false;
        let details: Schema.Json = null;

        if (command.action === "edit") {
          const patch = command.patch;

          const fields = (["name", "prompt", "schedule"] as const).filter(
            (field) => patch[field] !== undefined && !isDeepStrictEqual(patch[field], job[field]),
          );

          changedFields = fields;

          if (changedFields.length > 0) {
            const scheduleChanged = changedFields.includes("schedule");
            const schedule = patch.schedule ?? job.schedule;

            if (job.monitor && schedule.type !== "cron")
              throw new TaskError({
                message: "Monitoring requires a recurring cron schedule and timezone.",
              });

            if (scheduleChanged && schedule.type === "once" && schedule.at <= now)
              throw new TaskError({
                message: "Choose a future one-off time with an explicit UTC offset.",
              });

            const nextAt = scheduleChanged
              ? schedule.type === "once"
                ? schedule.at
                : nextOccurrence(schedule, now)
              : job.nextAt;

            baselineReset = job.monitor && changedFields.includes("prompt");

            const boundary = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Natural }))(
              database
                .query(
                  "SELECT COALESCE(MAX(id), 0) AS id FROM job_monitor_results WHERE job_id = ?",
                )
                .get(job.id),
            ).id;

            database
              .query(`UPDATE jobs SET name = ?, prompt = ?, schedule = ?, next_at = ?, revision = revision + 1,
            monitor_revision = ?, monitor_baseline_after = ? WHERE id = ?`)
              .run(
                patch.name ?? job.name,
                patch.prompt ?? job.prompt,
                JSON.stringify(schedule),
                nextAt,
                baselineReset ? job.revision + 1 : job.monitorRevision,
                baselineReset ? boundary : job.monitorBaselineAfter,
                job.id,
              );

            if (pending !== undefined) {
              database.run(
                "UPDATE job_occurrences SET status = 'cancelled', finished_at = ?, reason = 'task-edited' WHERE id = ?",
                [now, pending.id],
              );
              replacedOccurrenceIds = [pending.id];
              snoozeCleared = scheduleChanged && pending.availableAt > pending.scheduledAt;

              if (!scheduleChanged) {
                const id = insertOccurrence(task(job.id), pending.scheduledAt, {
                  availableAt: pending.availableAt,
                  origin: pending.origin,
                  destination: pending.destination,
                });

                selected = occurrence(id);
              }
            }

            const updated = task(job.id);
            details = {
              before: Object.fromEntries(fields.map((field) => [field, job[field]])),
              after: Object.fromEntries(fields.map((field) => [field, updated[field]])),
            };
          }
        } else {
          if (job.paused)
            throw new TaskError({ message: "Resume the task before changing its next execution." });

          if (!isDeepStrictEqual(command.target, nextTarget(job.id)))
            throw new TaskError({
              message: "The next execution changed. Inspect the task again before changing it.",
            });
          const target = command.target;

          const advance = (after: number) =>
            database.run("UPDATE jobs SET next_at = ? WHERE id = ?", [
              nextOccurrence(job.schedule, after),
              job.id,
            ]);

          if (command.action === "skip-next") {
            if (pending !== undefined) {
              database.run(
                "UPDATE job_occurrences SET status = 'cancelled', finished_at = ?, reason = 'skipped-by-owner' WHERE id = ?",
                [now, pending.id],
              );
              selected = occurrence(pending.id);
            } else {
              selected = occurrence(
                insertOccurrence(job, target.scheduledAt, {
                  availableAt: target.availableAt,
                  status: "cancelled",
                  reason: "skipped-by-owner",
                  finishedAt: now,
                }),
              );
              advance(target.scheduledAt);
            }

            changedFields = ["skip-next"];
          } else if (command.action === "snooze") {
            if (command.until <= now || command.until < target.availableAt)
              throw new TaskError({
                message: "Snooze until a future time later than the current ready time.",
              });

            if (command.until === target.availableAt) {
              selected = pending ?? null;
            } else {
              if (pending !== undefined) {
                database.run("UPDATE job_occurrences SET available_at = ? WHERE id = ?", [
                  command.until,
                  pending.id,
                ]);
                selected = occurrence(pending.id);
              } else {
                selected = occurrence(
                  insertOccurrence(job, target.scheduledAt, { availableAt: command.until }),
                );
                advance(target.scheduledAt);
              }

              changedFields = ["availableAt"];
            }
          } else if (pending !== undefined) {
            if (pending.availableAt > now)
              throw new TaskError({
                message:
                  "The next occurrence is held until a future time. Run-now cannot undo a hold.",
              });

            if (
              pending.definition.schedule.type === "cron" &&
              pending.availableAt <= now - recurringExpiry
            )
              throw new TaskError({
                message:
                  "This pending summary expired. Skip it or wait for reconciliation before running current work.",
              });
            selected = pending;
          } else {
            const due = target.scheduledAt <= now;
            const logical = job.schedule.type === "once" || due ? target.scheduledAt : now;

            const collision = database
              .query(
                "SELECT id FROM job_occurrences WHERE job_id = ? AND revision = ? AND scheduled_at = ?",
              )
              .get(job.id, job.revision, logical);

            if (collision !== null)
              throw new TaskError({
                message:
                  "An occurrence already exists at this time. Inspect its history before retrying.",
              });
            selected = occurrence(
              insertOccurrence(job, logical, {
                availableAt: Math.min(logical, now),
                origin: "manual",
              }),
            );

            if (job.schedule.type === "once" || due) {
              advance(now);
              const following = nextOccurrence(job.schedule, logical);

              if (following !== null && following <= now)
                database.run(
                  "INSERT INTO job_skips (job_id, first_at, last_at, reason) VALUES (?, ?, ?, 'worker-delayed')",
                  [job.id, following, now],
                );
            }

            changedFields = ["run-now"];
          }

          if (changedFields.length > 0)
            details = {
              target,
              occurrenceId: selected?.id ?? null,
              availableAt: selected?.availableAt ?? null,
              nextAt: task(job.id).nextAt,
            };
        }

        const updated = task(job.id);

        const receipt = Schema.decodeUnknownSync(ControlReceipt)({
          operationId: command.operationId,
          action: command.action,
          taskId: job.id,
          previousRevision: job.revision,
          revision: updated.revision,
          changedFields,
          nextAt: updated.nextAt,
          paused: updated.paused,
          replacedOccurrenceIds,
          baselineReset,
          snoozeCleared,
          occurrenceId: selected?.id ?? null,
          scheduledAt: selected?.scheduledAt ?? null,
          availableAt: selected?.availableAt ?? null,
        });

        database
          .query(
            "INSERT INTO job_operations (operation_id, job_id, command, receipt, changes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            command.operationId,
            job.id,
            JSON.stringify(command),
            JSON.stringify(receipt),
            details === null ? null : JSON.stringify(details),
            now,
          );

        return receipt;
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

        if (item.definition.monitor && item.revision < job.monitorRevision)
          throw new TaskError({
            message:
              "This monitor predates a prompt change. Use the next current-definition check.",
          });

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
        const item = occurrence(id);
        const job = executionTask(item);

        if (item.status === "running" && status === "completed" && job.monitor) {
          try {
            monitoring.finish(id, job);
          } catch (cause) {
            if (!(cause instanceof TaskError)) throw cause;
            status = "failed";
            reason = cause.message;
          }
        }

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
      CASE WHEN occurrences.reason LIKE 'monitor:%' THEN occurrences.reason ELSE runs.failure_reason END AS failureReason
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
    monitoring,
    list,
    listPage: (after: string | null, project?: string | null) => {
      if (after !== null) task(after);

      return Schema.decodeUnknownSync(Schema.Array(Task))(
        database
          .query(
            `${taskSql} WHERE id > ? AND (? OR json_extract(project, '$.name') IS ?) ORDER BY id LIMIT 11`,
          )
          .all(after ?? "", project === undefined ? 1 : 0, project ?? null),
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
            position: Schema.Natural,
            state: Schema.Literals(["pending", "sending", "sent", "failed", "uncertain"]),
            messageId: Schema.NullOr(Schema.String),
            attempts: Schema.Natural,
          }),
        ),
      )(
        database
          .query(`SELECT d.position, d.state, d.message_id AS messageId, d.attempts
      FROM gateway_deliveries d JOIN gateway_inbox i ON i.id = d.inbox_id
      WHERE i.occurrence_id = ? ORDER BY d.position`)
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
