import { randomUUID } from "node:crypto";

import { decodeRow } from "@poppet/store";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";

import {
  Task,
  Occurrence,
  TaskError,
  TaskDefinition,
  latestOccurrence,
  nextOccurrence,
  type Schedule,
  type TaskTarget,
} from "#src/task-schema";

// Recurring summaries lose their usefulness after a day. One-off work never expires.
export const recurringExpiry = 24 * 60 * 60 * 1000;

/** Converts storage and saved-row failures at the repository boundary. */
export const taskFailure = (cause: unknown) =>
  cause instanceof TaskError
    ? cause
    : new TaskError({ message: "Could not read or update scheduled tasks." });

// The schedule helpers throw TaskError; these keep that a typed failure inside transactions.
export const nextTime = (schedule: Schedule, after: number) =>
  Effect.try({ try: () => nextOccurrence(schedule, after), catch: taskFailure });

export const latestTime = (schedule: Schedule, atOrBefore: number) =>
  Effect.try({ try: () => latestOccurrence(schedule, atOrBefore), catch: taskFailure });

export const taskRecords = (sql: SqlClient.SqlClient) => {
  const tasks = sql`SELECT id, name, prompt, provider, model, workload, schedule, revision, skill,
    destination, next_at, paused, created_at, source FROM jobs`;

  const occurrences = sql`SELECT id, job_id, scheduled_at, status, revision, definition,
    available_at, origin, destination, session_id, run_id, finished_at, reason
    FROM job_occurrences`;

  const task = (id: string) =>
    sql`${tasks} WHERE id = ${id}`.pipe(
      decodeRow(Task),
      Effect.flatMap((row) =>
        row === null
          ? Effect.fail(new TaskError({ message: "The task does not exist. Use tasks list." }))
          : Effect.succeed(row),
      ),
    );

  const occurrence = (id: string) =>
    sql`${occurrences} WHERE id = ${id}`.pipe(
      decodeRow(Occurrence),
      Effect.flatMap((row) =>
        row === null
          ? Effect.fail(
              new TaskError({ message: "The occurrence does not exist. Use tasks show <task>." }),
            )
          : Effect.succeed(row),
      ),
    );

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
  ) =>
    Effect.gen(function* () {
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
      const definition = yield* Schema.decodeUnknownEffect(TaskDefinition)(job);

      yield* sql`INSERT INTO job_occurrences ${sql.insert({
        id,
        jobId: job.id,
        revision: job.revision,
        definition: JSON.stringify(definition),
        scheduledAt,
        availableAt,
        status,
        reason,
        finishedAt,
        origin,
        destination: destination === null ? null : JSON.stringify(destination),
      })} ${sql.literal(
        ignoreDuplicate ? "ON CONFLICT (job_id, revision, scheduled_at) DO NOTHING" : "",
      )}`;

      return id;
    });

  const activeOccurrence = (id: string, status: "pending" | "running") =>
    sql`${occurrences} WHERE job_id = ${id} AND status = ${status} LIMIT 1`.pipe(
      decodeRow(Occurrence),
    );

  const nextTarget = (id: string) =>
    Effect.gen(function* () {
      const job = yield* task(id);
      const pending = yield* activeOccurrence(id, "pending");

      if (pending !== null)
        return {
          occurrenceId: pending.id,
          scheduledAt: pending.scheduledAt,
          availableAt: pending.availableAt,
        } satisfies TaskTarget;

      return job.nextAt === null
        ? null
        : ({
            occurrenceId: null,
            scheduledAt: job.nextAt,
            availableAt: job.nextAt,
          } satisfies TaskTarget);
    });

  return {
    tasks,
    occurrences,
    task,
    occurrence,
    insertOccurrence,
    activeOccurrence,
    nextTarget,
  };
};
