import { ProviderId } from "@poppet/provider";
import { DeliveryDestination, Session, SkillName, SkillSnapshot } from "@poppet/store";
import { Cron, Data, Schema } from "effect";

/** A task validation, scheduling, or storage failure suitable for command output. */
export class TaskError extends Data.TaggedError("TaskError")<{
  readonly message: string;
}> {}

const boundedText = (bytes: number) =>
  Schema.NonEmptyString.check(
    Schema.isTrimmed(),
    Schema.makeFilter((text) => Buffer.byteLength(text) <= bytes || `Use at most ${bytes} bytes.`),
  );

/** A one-off Unix millisecond timestamp or a five-field cron schedule with a timezone. */
export const Schedule = Schema.Union([
  Schema.Struct({ type: Schema.Literal("once"), at: Schema.Natural }),
  Schema.Struct({
    type: Schema.Literal("cron"),
    expression: boundedText(256),
    timezone: boundedText(128),
  }),
]);

export type Schedule = typeof Schedule.Type;

/** Finds the latest cron time at or before the given Unix milliseconds. */
export const latestOccurrence = (schedule: Schedule, atOrBefore: number): number | null => {
  if (schedule.type === "once") return null;

  try {
    // Cron times fall on whole seconds and prev is strict, so search from the next second.
    return Cron.prev(
      Cron.parseUnsafe(schedule.expression, schedule.timezone),
      atOrBefore + 1000,
    ).getTime();
  } catch {
    throw new TaskError({ message: "Invalid cron expression or timezone." });
  }
};

/** Finds the next cron time after the given Unix milliseconds; one-off schedules do not repeat. */
export const nextOccurrence = (schedule: Schedule, after: number): number | null => {
  if (schedule.type === "once") return null;

  if (schedule.expression.split(/\s+/).length !== 5)
    throw new TaskError({
      message: "Use a five-field cron expression: minute hour day month weekday.",
    });

  try {
    return Cron.next(Cron.parseUnsafe(schedule.expression, schedule.timezone), after).getTime();
  } catch {
    throw new TaskError({
      message: "Invalid cron expression or timezone, or no upcoming occurrence.",
    });
  }
};

/** Parses an ISO timestamp with an explicit offset, rejecting invalid dates and pre-epoch times. */
export const parseTimestamp = (text: string): number => {
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      text,
    );

  const at = Date.parse(text);

  if (
    !parts ||
    !Number.isFinite(at) ||
    at < 0 ||
    Number(parts[3]) > new Date(Date.UTC(Number(parts[1]), Number(parts[2]), 0)).getUTCDate() ||
    Number(parts[4]) > 23
  )
    throw new TaskError({
      message:
        "Use an ISO timestamp with Z or an explicit offset, such as 2026-10-15T09:00:00+01:00.",
    });

  return at;
};

/** Task input with an explicit provider and model, independent of later host defaults. */
export const NewTask = Schema.Struct({
  name: boundedText(128),
  prompt: boundedText(16_384),
  provider: ProviderId,
  model: boundedText(1024),
  workload: Session.fields.workload,
  schedule: Schedule,
});

export type NewTask = typeof NewTask.Type;

export const TaskPatch = Schema.Struct({
  name: Schema.optionalKey(NewTask.fields.name),
  prompt: Schema.optionalKey(NewTask.fields.prompt),
  schedule: Schema.optionalKey(Schedule),
}).check(Schema.makeFilter((patch) => Object.keys(patch).length > 0));

/** The next execution: the pending occurrence, or the unqueued next slot. */
export interface TaskTarget {
  readonly occurrenceId: string | null;
  readonly scheduledAt: number;
  readonly availableAt: number;
}

/** Owner changes to a task's definition or its next execution. */
export const TaskControl = Schema.Union([
  Schema.Struct({ action: Schema.Literal("edit"), id: Session.fields.id, patch: TaskPatch }),
  Schema.Struct({ action: Schema.Literals(["skip-next", "run-now"]), id: Session.fields.id }),
  Schema.Struct({
    action: Schema.Literal("snooze"),
    id: Session.fields.id,
    until: Schema.Natural,
  }),
]);

export type TaskControl = typeof TaskControl.Type;

/** Controls act on a task's next execution and share one transaction. */
export const isTaskControl = Schema.is(TaskControl);

/** Commands accepted by both the local task store and the worker endpoint. */
export const TaskCommand = Schema.Union([
  TaskControl,
  Schema.Struct({
    action: Schema.Literal("add"),
    task: NewTask,
    skill: Schema.optionalKey(SkillName),
    delivery: Schema.optionalKey(
      Schema.Struct({
        adapter: DeliveryDestination.fields.adapter,
        conversationId: Schema.NullOr(DeliveryDestination.fields.conversationId),
      }),
    ),
  }),
  Schema.Struct({ action: Schema.Literals(["list", "providers", "clear", "status"]) }),
  Schema.Struct({
    action: Schema.Literals(["show", "pause", "resume", "cancel", "retry"]),
    id: Session.fields.id,
  }),
  Schema.Struct({ action: Schema.Literal("resume-provider"), provider: ProviderId }),
]);

export type TaskCommand = typeof TaskCommand.Type;

/** A persisted task row whose JSON schedule is decoded on read; times are Unix milliseconds. */
export const Task = Schema.Struct({
  ...NewTask.fields,
  revision: Schema.Natural,
  destination: Schema.NullOr(Schema.fromJsonString(DeliveryDestination)),
  skill: Schema.NullOr(Schema.fromJsonString(SkillSnapshot)),
  schedule: Schema.fromJsonString(Schedule),
  id: Session.fields.id,
  nextAt: Schema.NullOr(Schema.Natural),
  paused: Schema.Literals([0, 1]),
  createdAt: Schema.Natural,
});

export type Task = typeof Task.Type;

/** Immutable execution fields, independent of later edits and host defaults. */
export const TaskDefinition = Schema.Struct({
  ...NewTask.fields,
  skill: Schema.NullOr(SkillSnapshot),
});

/** One scheduled execution, linked to its session and run as they are created. */
export const Occurrence = Schema.Struct({
  id: Session.fields.id,
  jobId: Session.fields.id,
  revision: Schema.Natural,
  definition: Schema.fromJsonString(TaskDefinition),
  destination: Schema.NullOr(Schema.fromJsonString(DeliveryDestination)),
  scheduledAt: Schema.Natural,
  availableAt: Schema.Natural,
  origin: Schema.Literals(["scheduled", "manual"]),
  status: Schema.Literals([
    "pending",
    "running",
    "completed",
    "failed",
    "interrupted",
    "cancelled",
    "expired",
  ]),
  sessionId: Schema.NullOr(Session.fields.id),
  runId: Schema.NullOr(Session.fields.id),
  finishedAt: Schema.NullOr(Schema.Natural),
  reason: Schema.NullOr(Schema.String),
});

export type Occurrence = typeof Occurrence.Type;

/** A provider-wide scheduling pause; null resumeAt requires explicit manual resumption. */
export const ProviderPause = Schema.Struct({
  provider: ProviderId,
  reason: Schema.Literals(["quota", "temporary", "rate-limit"]),
  resumeAt: Schema.NullOr(Schema.Natural),
  failures: Schema.Natural,
});

export type ProviderPause = typeof ProviderPause.Type;

/** A range of schedule times skipped during reconciliation, with the reason recorded. */
export const Skipped = Schema.Struct({
  firstAt: Schema.Natural,
  lastAt: Schema.Natural,
  reason: Schema.String,
});
