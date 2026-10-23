import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { Schema } from "effect";

import { Task, Occurrence, TaskError, TaskDefinition, type TaskTarget } from "#src/task-schema";

// Recurring summaries lose their usefulness after a day. One-off work never expires.
export const recurringExpiry = 24 * 60 * 60 * 1000;

export const taskSql = `SELECT id, name, prompt, provider, model, workload, schedule,
  revision,
  skill, destination, next_at AS nextAt, paused, created_at AS createdAt FROM jobs`;

export const occurrenceSql = `SELECT id, job_id AS jobId, scheduled_at AS scheduledAt, status,
  revision, definition, available_at AS availableAt, origin,
  destination, session_id AS sessionId, run_id AS runId, finished_at AS finishedAt, reason FROM job_occurrences`;

export const taskRecords = (database: Database) => {
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

  return { task, occurrence, insertOccurrence, activeOccurrence, nextTarget };
};
