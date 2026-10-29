import { ProviderId } from "@poppet/provider";
import { Session } from "@poppet/store";
import { TaskPatch, NewTask, parseTimestamp, TaskError, taskOperation } from "@poppet/tasks";
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { codingFlag, skillFlag, textArgument } from "#src/commands/flags";
import { parseTaskSchedule, prepareTask, runTaskCommand } from "#src/tasks";

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
          action === "run-now" ? "run" : action,
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
        },
        ({ id, until }) =>
          Effect.gen(function* () {
            const at = yield* taskOperation(() => {
              if (until[0] === undefined)
                throw new TaskError({
                  message: "Use --until with a future timestamp including Z or an offset.",
                });

              return parseTimestamp(until[0]);
            });

            yield* runTaskCommand(runtime, { action: "snooze", id, until: at });
          }),
      ).pipe(Command.withDescription("Delay the next execution until a later absolute time")),
      Command.make(
        "add",
        {
          name: Argument.String("name"),
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
          coding: codingFlag,
          skill: skillFlag,
          channel: Flag.String("channel").pipe(
            Flag.withSchema(Schema.NonEmptyString),
            Flag.withDescription("Gateway ID for scheduled result delivery"),
            Flag.atMost(1),
            Flag.map(([value]) => value),
          ),
          conversation: Flag.String("conversation").pipe(
            Flag.withSchema(Schema.NonEmptyString),
            Flag.withDescription(
              "Channel or thread ID for results (defaults to the gateway home channel)",
            ),
            Flag.atMost(1),
            Flag.map(([value]) => value),
          ),
          prompt: textArgument("prompt"),
        },
        ({ name, at, cron, tz, coding, prompt, skill, channel, conversation }) =>
          Effect.gen(function* () {
            const schedule = yield* taskOperation(() => parseTaskSchedule(at, cron, tz));

            if (channel === undefined && conversation !== undefined)
              return yield* Effect.fail(
                new TaskError({ message: "Use --channel when selecting --conversation." }),
              );

            const delivery =
              channel !== undefined
                ? { adapter: channel, conversationId: conversation ?? null }
                : undefined;

            const command = yield* prepareTask(name, schedule, coding, prompt, skill, delivery);

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
      ...(["show", "pause", "resume", "delete", "cancel", "retry"] as const).map((action) =>
        Command.make(
          action === "delete" ? "remove" : action,
          {
            id: Argument.String(
              action === "cancel" || action === "retry" ? "occurrence" : "task",
            ).pipe(Argument.withSchema(Session.fields.id)),
          },
          ({ id }) => runTaskCommand(runtime, { action, id }),
        ).pipe(
          Command.withDescription(
            {
              show: "Show occurrences, results, and skipped intervals",
              pause: "Pause scheduling and cancel pending work",
              resume: "Resume future occurrences",
              delete: "Remove a task and its history unless it is running",
              cancel: "Cancel pending or active work",
              retry: "Explicitly retry an unsuccessful occurrence",
            }[action],
          ),
        ),
      ),
    ]),
  );
};
