import { ProviderId } from "@poppet/provider";
import { Session } from "@poppet/store";
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
  workload: Session.fields.workload,
  schedule: Schedule,
});

export type NewTask = typeof NewTask.Type;

export const TaskCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("add"), task: NewTask }),
  Schema.Struct({ action: Schema.Literals(["list", "providers", "clear", "status"]) }),
  Schema.Struct({
    action: Schema.Literals(["show", "pause", "resume", "cancel", "retry"]),
    id: Session.fields.id,
  }),
  Schema.Struct({ action: Schema.Literal("resume-provider"), provider: ProviderId }),
]);

export type TaskCommand = typeof TaskCommand.Type;

export const Task = Schema.Struct({
  ...NewTask.fields,
  schedule: Schema.fromJsonString(Schedule),
  id: Session.fields.id,
  nextAt: Schema.NullOr(Schema.Natural),
  paused: Schema.Literals([0, 1]),
  createdAt: Schema.Natural,
});

export type Task = typeof Task.Type;

export const Occurrence = Schema.Struct({
  id: Session.fields.id,
  jobId: Session.fields.id,
  scheduledAt: Schema.Natural,
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
