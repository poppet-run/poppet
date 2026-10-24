import { isDeepStrictEqual } from "node:util";

import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";

import { nextTime, taskRecords, recurringExpiry } from "#src/task-records";
import { TaskControl, TaskError, type Occurrence } from "#src/task-schema";

/** What a control changed, and the execution it selected; times are Unix milliseconds. */
export interface ControlReceipt {
  readonly action: TaskControl["action"];
  readonly taskId: string;
  readonly previousRevision: number;
  readonly revision: number;
  readonly changedFields: ReadonlyArray<string>;
  readonly nextAt: number | null;
  readonly paused: 0 | 1;
  readonly occurrenceId: string | null;
  readonly replacedOccurrenceIds: ReadonlyArray<string>;
  readonly snoozeCleared: boolean;
  readonly scheduledAt: number | null;
  readonly availableAt: number | null;
}

const reject = (message: string) => Effect.fail(new TaskError({ message }));

export const taskControls = (sql: SqlClient.SqlClient) => {
  const { task, occurrence, insertOccurrence, activeOccurrence, nextTarget } = taskRecords(sql);

  /** Revision/target checks and state changes share one transaction. */
  return (input: TaskControl, now: number) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const command = yield* Schema.decodeUnknownEffect(TaskControl, {
          onExcessProperty: "error",
        })(input);

        const job = yield* task(command.id);

        if (job.revision !== command.revision)
          return yield* reject("The task definition changed. Inspect it again before changing it.");

        if ((yield* activeOccurrence(job.id, "running")) !== null)
          return yield* reject("Cancel the running occurrence before changing this task.");

        const pending = yield* activeOccurrence(job.id, "pending");
        let selected: Occurrence | null = null;
        let replacedOccurrenceIds: string[] = [];
        let changedFields: string[] = [];
        let snoozeCleared = false;

        if (command.action === "edit") {
          const patch = command.patch;

          const fields = (["name", "prompt", "schedule"] as const).filter(
            (field) => patch[field] !== undefined && !isDeepStrictEqual(patch[field], job[field]),
          );

          changedFields = fields;

          if (changedFields.length > 0) {
            const scheduleChanged = changedFields.includes("schedule");
            const schedule = patch.schedule ?? job.schedule;

            if (scheduleChanged && schedule.type === "once" && schedule.at <= now)
              return yield* reject("Choose a future one-off time with an explicit UTC offset.");

            const nextAt = scheduleChanged
              ? schedule.type === "once"
                ? schedule.at
                : yield* nextTime(schedule, now)
              : job.nextAt;

            yield* sql`UPDATE jobs SET name = ${patch.name ?? job.name},
              prompt = ${patch.prompt ?? job.prompt}, schedule = ${JSON.stringify(schedule)},
              next_at = ${nextAt}, revision = revision + 1 WHERE id = ${job.id}`;

            if (pending !== null) {
              yield* sql`UPDATE job_occurrences SET status = 'cancelled', finished_at = ${now},
                reason = 'task-edited' WHERE id = ${pending.id}`;
              replacedOccurrenceIds = [pending.id];
              snoozeCleared = scheduleChanged && pending.availableAt > pending.scheduledAt;

              if (!scheduleChanged) {
                const id = yield* insertOccurrence(yield* task(job.id), pending.scheduledAt, {
                  availableAt: pending.availableAt,
                  origin: pending.origin,
                  destination: pending.destination,
                });

                selected = yield* occurrence(id);
              }
            }
          }
        } else {
          if (job.paused)
            return yield* reject("Resume the task before changing its next execution.");

          if (!isDeepStrictEqual(command.target, yield* nextTarget(job.id)))
            return yield* reject(
              "The next execution changed. Inspect the task again before changing it.",
            );

          const target = command.target;

          const advance = (after: number) =>
            Effect.flatMap(
              nextTime(job.schedule, after),
              (nextAt) => sql`UPDATE jobs SET next_at = ${nextAt} WHERE id = ${job.id}`,
            );

          if (command.action === "skip-next") {
            if (pending !== null) {
              yield* sql`UPDATE job_occurrences SET status = 'cancelled', finished_at = ${now},
                reason = 'skipped-by-owner' WHERE id = ${pending.id}`;
              selected = yield* occurrence(pending.id);
            } else {
              selected = yield* occurrence(
                yield* insertOccurrence(job, target.scheduledAt, {
                  availableAt: target.availableAt,
                  status: "cancelled",
                  reason: "skipped-by-owner",
                  finishedAt: now,
                }),
              );
              yield* advance(target.scheduledAt);
            }

            changedFields = ["skip-next"];
          } else if (command.action === "snooze") {
            if (command.until <= now || command.until < target.availableAt)
              return yield* reject("Snooze until a future time later than the current ready time.");

            if (command.until === target.availableAt) {
              selected = pending;
            } else {
              if (pending !== null) {
                yield* sql`UPDATE job_occurrences SET available_at = ${command.until}
                  WHERE id = ${pending.id}`;
                selected = yield* occurrence(pending.id);
              } else {
                selected = yield* occurrence(
                  yield* insertOccurrence(job, target.scheduledAt, { availableAt: command.until }),
                );
                yield* advance(target.scheduledAt);
              }

              changedFields = ["availableAt"];
            }
          } else if (pending !== null) {
            if (pending.availableAt > now)
              return yield* reject(
                "The next occurrence is held until a future time. Run-now cannot undo a hold.",
              );

            if (
              pending.definition.schedule.type === "cron" &&
              pending.availableAt <= now - recurringExpiry
            )
              return yield* reject(
                "This pending summary expired. Skip it or wait for reconciliation before running current work.",
              );
            selected = pending;
          } else {
            const due = target.scheduledAt <= now;
            const logical = job.schedule.type === "once" || due ? target.scheduledAt : now;

            const collision = yield* sql`SELECT id FROM job_occurrences
              WHERE job_id = ${job.id} AND revision = ${job.revision} AND scheduled_at = ${logical}`;

            if (collision.length > 0)
              return yield* reject(
                "An occurrence already exists at this time. Inspect its history before retrying.",
              );

            selected = yield* occurrence(
              yield* insertOccurrence(job, logical, {
                availableAt: Math.min(logical, now),
                origin: "manual",
              }),
            );

            if (job.schedule.type === "once" || due) {
              yield* advance(now);
              const following = yield* nextTime(job.schedule, logical);

              if (following !== null && following <= now)
                yield* sql`INSERT INTO job_skips (job_id, first_at, last_at, reason)
                  VALUES (${job.id}, ${following}, ${now}, 'worker-delayed')`;
            }

            changedFields = ["run-now"];
          }
        }

        const updated = yield* task(job.id);

        return {
          action: command.action,
          taskId: job.id,
          previousRevision: job.revision,
          revision: updated.revision,
          changedFields,
          nextAt: updated.nextAt,
          paused: updated.paused,
          replacedOccurrenceIds,
          snoozeCleared,
          occurrenceId: selected?.id ?? null,
          scheduledAt: selected?.scheduledAt ?? null,
          availableAt: selected?.availableAt ?? null,
        } satisfies ControlReceipt;
      }),
    );
};
