import { Session } from "@poppet/store";
import { TaskPatch, NewTask, TaskError, taskOperation } from "@poppet/tasks";
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { jsonFlag, skillFlag, textArgument } from "#src/commands/flags";
import {
  parseTaskDestination,
  parseTaskSchedule,
  prepareTask,
  runTaskCommand,
} from "#src/commands/tasks/tasks";

export const tasksCommand = (context: CLIContext) => {
  const { runtime } = context;

  return Command.make("tasks", { json: jsonFlag }, ({ json }) =>
    runTaskCommand(runtime, { action: "list" }, json),
  ).pipe(
    Command.withDescription("Schedule and manage requests"),
    Command.withSubcommands([
      Command.make(
        "edit",
        {
          id: Argument.String("task").pipe(Argument.withSchema(Session.fields.id)),
          name: Flag.String("name").pipe(Flag.withSchema(NewTask.fields.name), Flag.atMost(1)),
          prompt: Flag.String("prompt").pipe(
            Flag.withSchema(NewTask.fields.prompt),
            Flag.atMost(1),
          ),
          at: Flag.String("at").pipe(Flag.atMost(1)),
          cron: Flag.String("cron").pipe(Flag.atMost(1)),
          tz: Flag.String("tz").pipe(Flag.atMost(1)),
          json: jsonFlag,
        },
        ({ id, name, prompt, at, cron, tz, json }) =>
          Effect.gen(function* () {
            const patch = yield* taskOperation(() => {
              const fields: Record<string, Schema.Json> = {};

              if (name[0] !== undefined) fields.name = name[0];

              if (prompt[0] !== undefined) fields.prompt = prompt[0];

              if (at.length + cron.length + tz.length > 0)
                fields.schedule = parseTaskSchedule(
                  Option.fromUndefinedOr(at[0]),
                  Option.fromUndefinedOr(cron[0]),
                  Option.fromUndefinedOr(tz[0]),
                );

              if (Object.keys(fields).length === 0)
                throw new TaskError({
                  message: "Supply --name, --prompt, --at, or --cron with --tz.",
                });

              return Schema.decodeUnknownSync(TaskPatch)(fields);
            });

            yield* runTaskCommand(runtime, { action: "edit", id, patch }, json);
          }),
      ).pipe(Command.withDescription("Edit a task's name, prompt or complete schedule")),
      Command.make(
        "run",
        {
          id: Argument.String("task").pipe(Argument.withSchema(Session.fields.id)),
          json: jsonFlag,
        },
        ({ id, json }) => runTaskCommand(runtime, { action: "run-now", id }, json),
      ).pipe(Command.withDescription("Queue one execution through the worker")),
      Command.make(
        "add",
        {
          name: Argument.String("name"),
          delay: Flag.String("in").pipe(
            Flag.withDescription("Run once after a duration, such as 10m"),
            Flag.atMost(1),
            Flag.map(([value]) => Option.fromUndefinedOr(value)),
          ),
          at: Flag.String("at").pipe(
            Flag.withDescription("One-off timestamp with timezone"),
            Flag.atMost(1),
            Flag.map(([value]) => Option.fromUndefinedOr(value)),
          ),
          cron: Flag.String("cron").pipe(
            Flag.withDescription("Recurring cron expression"),
            Flag.atMost(1),
            Flag.map(([value]) => Option.fromUndefinedOr(value)),
          ),
          tz: Flag.String("tz").pipe(
            Flag.withDescription("Timezone for --cron"),
            Flag.atMost(1),
            Flag.map(([value]) => Option.fromUndefinedOr(value)),
          ),
          skill: skillFlag,
          to: Flag.String("to").pipe(
            Flag.withDescription("Deliver to <gateway> or <gateway>:<conversation-id>"),
            Flag.atMost(1),
            Flag.map(([value]) => value),
          ),
          json: jsonFlag,
          prompt: textArgument("prompt"),
        },
        ({ name, at, cron, tz, delay, prompt, skill, to, json }) =>
          Effect.gen(function* () {
            const schedule = yield* taskOperation(() => parseTaskSchedule(at, cron, tz, delay));

            const delivery = yield* taskOperation(() => parseTaskDestination(to));

            const command = yield* prepareTask(name, schedule, prompt, skill, delivery);

            yield* runTaskCommand(runtime, command, json);
          }).pipe(Effect.provide(runtime.config)),
      ).pipe(
        Command.withDescription("Schedule a request"),
        Command.withExamples([
          {
            command:
              'poppet tasks add Later --at 2099-10-15T09:00:00Z "Review recent conversations"',
          },
          {
            command:
              'poppet tasks add Daily --cron "0 9 * * *" --tz Europe/London "Review recent conversations"',
          },
        ]),
      ),
      ...(["list", "clear"] as const).map((action) =>
        Command.make(action, { json: jsonFlag }, ({ json }) =>
          runTaskCommand(runtime, { action }, json),
        ).pipe(
          Command.withDescription(
            {
              list: "List saved tasks",
              clear: "Interrupt active work and remove all tasks and task history",
            }[action],
          ),
        ),
      ),
      ...(["cancel", "retry"] as const).map((action) =>
        Command.make(
          action,
          {
            id: Argument.String("task").pipe(Argument.withSchema(Session.fields.id)),
            occurrence: Flag.String("occurrence").pipe(
              Flag.withSchema(Session.fields.id),
              Flag.atMost(1),
            ),
            json: jsonFlag,
          },
          ({ id, occurrence, json }) => {
            const command = {
              action: action === "cancel" ? ("cancel-task" as const) : ("retry-task" as const),
              id,
            };

            return runTaskCommand(
              runtime,
              occurrence[0] === undefined ? command : { ...command, occurrenceId: occurrence[0] },
              json,
            );
          },
        ).pipe(
          Command.withDescription(
            action === "cancel"
              ? "Cancel the task's pending or active execution"
              : "Retry the task's latest execution if unsuccessful",
          ),
        ),
      ),
      ...(["show", "pause", "resume", "delete"] as const).map((action) =>
        Command.make(
          action === "delete" ? "remove" : action,
          {
            id: Argument.String("task").pipe(Argument.withSchema(Session.fields.id)),
            json: jsonFlag,
          },
          ({ id, json }) => runTaskCommand(runtime, { action, id }, json),
        ).pipe(
          Command.withDescription(
            {
              show: "Show occurrences, results, and skipped intervals",
              pause: "Pause scheduling and cancel pending work",
              resume: "Resume future occurrences",
              delete: "Remove a task and its history unless it is running",
            }[action],
          ),
        ),
      ),
    ]),
  );
};
