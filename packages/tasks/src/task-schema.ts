import { ProviderId } from "@poppet/provider";
import { DeliveryDestination, Session, SkillName, SkillSnapshot } from "@poppet/store";
import { Cron, Data, Schema } from "effect";

export class TaskError extends Data.TaggedError("TaskError")<{
  readonly message: string;
}> {}

const boundedText = (bytes: number) =>
  Schema.NonEmptyString.check(
    Schema.isTrimmed(),
    Schema.makeFilter((text) => Buffer.byteLength(text) <= bytes || `Use at most ${bytes} bytes.`),
  );

export const Schedule = Schema.Union([
  Schema.Struct({ type: Schema.Literal("once"), at: Schema.Natural }),
  Schema.Struct({
    type: Schema.Literal("cron"),
    expression: boundedText(256),
    timezone: boundedText(128),
  }),
]);

export type Schedule = typeof Schedule.Type;

export const latestOccurrence = (schedule: Schedule, atOrBefore: number): number | null => {
  if (schedule.type === "once") return null;

  try {
    return Cron.prev(
      Cron.parseUnsafe(schedule.expression, schedule.timezone),
      atOrBefore + 1000,
    ).getTime();
  } catch {
    throw new TaskError({ message: "Invalid cron expression or timezone." });
  }
};

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

export const nextSlot = (
  schedule: Schedule,
  after: number,
  endAt: number | null,
): number | null => {
  const next = nextOccurrence(schedule, after);

  return next !== null && endAt !== null && next > endAt ? null : next;
};

export const checkEndTime = (
  schedule: Schedule,
  endAt: number,
  now: number,
  needsSlot = false,
): void => {
  if (schedule.type === "once")
    throw new TaskError({
      message: "An end time applies only to recurring tasks. Use it with a cron schedule.",
    });

  if (endAt <= now)
    throw new TaskError({ message: "Choose a future end time with an explicit UTC offset." });

  if (needsSlot && nextSlot(schedule, now, endAt) === null)
    throw new TaskError({
      message: "The end time is before the first occurrence. Choose a later end time.",
    });
};

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

export const NewTask = Schema.Struct({
  name: boundedText(128),
  prompt: boundedText(16_384),
  provider: ProviderId,
  model: boundedText(1024),
  schedule: Schedule,
});

export type NewTask = typeof NewTask.Type;

export const TaskPatch = Schema.Struct({
  name: Schema.optionalKey(NewTask.fields.name),
  prompt: Schema.optionalKey(NewTask.fields.prompt),
  schedule: Schema.optionalKey(Schedule),
  endAt: Schema.optionalKey(Schema.NullOr(Schema.Natural)),
}).check(Schema.makeFilter((patch) => Object.keys(patch).length > 0));

export interface TaskTarget {
  readonly occurrenceId: string | null;
  readonly scheduledAt: number;
  readonly availableAt: number;
}

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

export const isTaskControl = Schema.is(TaskControl);

export const TaskCommand = Schema.Union([
  TaskControl,
  Schema.Struct({
    action: Schema.Literal("add"),
    task: NewTask,
    endAt: Schema.optionalKey(Schema.Natural),
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
    action: Schema.Literals(["show", "pause", "resume", "delete"]),
    id: Session.fields.id,
  }),
  Schema.Struct({
    action: Schema.Literals(["cancel-task", "retry-task"]),
    id: Session.fields.id,
    occurrenceId: Schema.optionalKey(Session.fields.id),
  }),
  Schema.Struct({ action: Schema.Literal("resume-provider"), provider: ProviderId }),
]);

export type TaskCommand = typeof TaskCommand.Type;

export const Task = Schema.Struct({
  ...NewTask.fields,
  revision: Schema.Natural,
  destination: Schema.NullOr(Schema.fromJsonString(DeliveryDestination)),
  skill: Schema.NullOr(Schema.fromJsonString(SkillSnapshot)),
  schedule: Schema.fromJsonString(Schedule),
  id: Session.fields.id,
  nextAt: Schema.NullOr(Schema.Natural),
  endAt: Schema.NullOr(Schema.Natural),
  paused: Schema.Literals([0, 1]),
  createdAt: Schema.Natural,
});

export type Task = typeof Task.Type;

export const TaskDefinition = Schema.Struct({
  ...NewTask.fields,
  skill: Schema.NullOr(SkillSnapshot),
});

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

export const ProviderPause = Schema.Struct({
  provider: ProviderId,
  reason: Schema.Literals(["quota", "temporary", "rate-limit"]),
  resumeAt: Schema.NullOr(Schema.Natural),
  failures: Schema.Natural,
});

export type ProviderPause = typeof ProviderPause.Type;

export const Skipped = Schema.Struct({
  firstAt: Schema.Natural,
  lastAt: Schema.Natural,
  reason: Schema.String,
});
