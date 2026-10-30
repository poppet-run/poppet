import { ProviderId } from "@poppet/provider";
import { Session } from "@poppet/store";
import { TaskPatch, NewTask, parseTimestamp, TaskError, taskOperation } from "@poppet/tasks";
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { skillFlag, textArgument } from "#src/commands/flags";
import {
  parseRelativeTime,
  parseTaskDestination,
  parseTaskSchedule,
  prepareTask,
  runTaskCommand,
} from "#src/tasks";

export const tasksCommand = (context: CLIContext) => {
  const { runtime } = context;

  return Command.make("tasks", {}, () => runTaskCommand(runtime, { action: "list" })).pipe(
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
        },
        ({ id, name, prompt, at, cron, tz }) =>
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

            yield* runTaskCommand(runtime, { action: "edit", id, patch });
          }),
      ).pipe(Command.withDescription("Edit a task's name, prompt or complete schedule")),
      ...(["skip-next", "run-now"] as const).map((action) =>
        Command.make(
          action === "run-now" ? "run" : "skip",
          { id: Argument.String("task").pipe(Argument.withSchema(Session.fields.id)) },
          ({ id }) => runTaskCommand(runtime, { action, id }),
        ).pipe(
          Command.withDescription(
            action === "skip-next"
              ? "Skip the next execution"
              : "Queue one execution through the worker",
          ),
        ),
      ),
      Command.make(
        "snooze",
        {
          id: Argument.String("task").pipe(Argument.withSchema(Session.fields.id)),
          until: Flag.String("until").pipe(Flag.atMost(1)),
          duration: Flag.String("for").pipe(
            Flag.withDescription("Delay until this duration from now, such as 1h"),
            Flag.atMost(1),
          ),
        },
        ({ id, until, duration }) =>
          Effect.gen(function* () {
            const at = yield* taskOperation(() => {
              if (until.length + duration.length !== 1)
                throw new TaskError({
                  message: "Use --until <timestamp> or --for <duration>.",
                });

              return duration[0] !== undefined
                ? parseRelativeTime(duration[0])
                : parseTimestamp(until[0]!);
            });

            yield* runTaskCommand(runtime, { action: "snooze", id, until: at });
          }),
      ).pipe(Command.withDescription("Delay the next execution")),
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
          prompt: textArgument("prompt"),
        },
        ({ name, at, cron, tz, delay, prompt, skill, to }) =>
          Effect.gen(function* () {
            const schedule = yield* taskOperation(() => parseTaskSchedule(at, cron, tz, delay));

            const delivery = yield* taskOperation(() => parseTaskDestination(to));

            const command = yield* prepareTask(name, schedule, prompt, skill, delivery);

            yield* runTaskCommand(runtime, command);
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
      Command.make("providers", {}, () => runTaskCommand(runtime, { action: "providers" })).pipe(
        Command.withDescription("Show provider quota pauses and temporary backoff"),
      ),
      Command.make(
        "resume-provider",
        {
          provider: Argument.String("provider").pipe(Argument.withSchema(ProviderId)),
        },
        ({ provider }) => runTaskCommand(runtime, { action: "resume-provider", provider }),
      ).pipe(Command.withDescription("Allow scheduled requests for a provider again")),
      ...(["list", "clear"] as const).map((action) =>
        Command.make(action, {}, () => runTaskCommand(runtime, { action })).pipe(
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
          },
          ({ id, occurrence }) => {
            const command = {
              action: action === "cancel" ? ("cancel-task" as const) : ("retry-task" as const),
              id,
            };

            return runTaskCommand(
              runtime,
              occurrence[0] === undefined ? command : { ...command, occurrenceId: occurrence[0] },
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
          },
          ({ id }) => runTaskCommand(runtime, { action, id }),
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
