import type { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";

import { Schema } from "effect";

import { taskRecords, recurringExpiry } from "#src/task-records";
import {
  TaskControl,
  ControlReceipt,
  TaskError,
  type Occurrence,
  nextOccurrence,
} from "#src/task-schema";

export const taskControls = (database: Database) => {
  const { task, occurrence, insertOccurrence, activeOccurrence, nextTarget } =
    taskRecords(database);

  /** Revision/target checks, state changes, history and replay receipts share one transaction. */
  return (input: TaskControl, now: number) =>
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
};
