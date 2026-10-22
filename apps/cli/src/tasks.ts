import { randomUUID } from "node:crypto";

import { AppConfig } from "@poppet/config";
import {
  TaskCommand,
  TaskControl,
  TaskPatch,
  TaskInspection,
  TaskError,
  nextOccurrence,
  parseTimestamp,
  taskOperation,
  type Schedule,
} from "@poppet/tasks";
import { Effect, Option, Schema } from "effect";

/** Bind a CLI mutation to the exact task/next execution returned by inspection. */
export const prepareTaskControl = (
  inspection: typeof TaskInspection.Type,
  action: TaskControl["action"],
  patch?: typeof TaskPatch.Type,
  until?: number,
): TaskControl => {
  const { task, target } = inspection;
  const base = { id: task.id, revision: task.revision, operationId: randomUUID() };

  if (action === "edit") return Schema.decodeUnknownSync(TaskControl)({ ...base, action, patch });

  if (target === null)
    throw new TaskError({
      message: "This task has no upcoming execution. Edit its schedule to rearm it.",
    });

  if (action === "snooze")
    return Schema.decodeUnknownSync(TaskControl)({ ...base, action, target, until });

  return Schema.decodeUnknownSync(TaskControl)({ ...base, action, target });
};

export const parseTaskSchedule = (
  at: Option.Option<string>,
  cron: Option.Option<string>,
  tz: Option.Option<string>,
): Schedule => {
  if (Option.isSome(at) && Option.isNone(cron) && Option.isNone(tz))
    return { type: "once", at: parseTimestamp(at.value) };

  if (Option.isNone(at) && Option.isSome(cron) && Option.isSome(tz))
    return { type: "cron", expression: cron.value, timezone: tz.value };

  throw new TaskError({
    message: "Use either --at <timestamp> or --cron <expression> --tz <timezone>.",
  });
};

export const prepareTask = (
  name: string,
  schedule: Schedule,
  coding: boolean,
  prompt: string,
  skill?: string,
  delivery?: { readonly adapter: string; readonly conversationId: string },
  monitor = false,
  project?: string,
) =>
  Effect.gen(function* () {
    yield* taskOperation(() => {
      if (monitor && schedule.type !== "cron")
        throw new TaskError({ message: "Monitoring requires --cron and an explicit timezone." });

      return nextOccurrence(schedule, Date.now());
    });
    const config = yield* AppConfig;

    if (config.model === null)
      return yield* Effect.fail(
        new TaskError({
          message: "Set model in config.json or POPPET_MODEL before adding a task.",
        }),
      );

    const command = {
      action: monitor ? "add-monitor" : "add",
      task: {
        name,
        schedule,
        prompt,
        provider: config.provider,
        model: config.model,
        workload: coding ? "coding" : "assistant",
      },
    };

    const selected = delivery === undefined ? command : { ...command, delivery };

    const scoped = project === undefined ? selected : { ...selected, project };

    return yield* Schema.decodeUnknownEffect(TaskCommand)(
      skill === undefined ? scoped : { ...scoped, skill },
    ).pipe(
      Effect.mapError(
        () =>
          new TaskError({
            message:
              "Use a nonempty task name up to 128 bytes, a prompt up to 16384 bytes, and a model ID up to 1024 bytes, with no surrounding whitespace. Run poppet --help.",
          }),
      ),
    );
  });
