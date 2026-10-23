import { Session } from "@poppet/store";
import { TaskPatch, NewTask, parseTimestamp, TaskError, taskOperation } from "@poppet/tasks";
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { codingFlag, skillFlag, textArgument } from "#src/commands/flags";
import { parseTaskSchedule, prepareTask, prepareTaskControl, runTaskCommand } from "#src/tasks";

export const tasksCommand = (context: CLIContext) => {
  const { runtime } = context;

  return Command.make("tasks").pipe(
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

            yield* runTaskCommand(runtime, { action: "inspect", id }, (value) =>
              prepareTaskControl(value, "edit", patch),
            );
          }),
      ).pipe(Command.withDescription("Edit a task's name, prompt or complete schedule")),
      ...(["skip-next", "run-now"] as const).map((action) =>
        Command.make(
          action === "run-now" ? "run" : action,
          { id: Argument.String("task").pipe(Argument.withSchema(Session.fields.id)) },
          ({ id }) =>
            runTaskCommand(runtime, { action: "inspect", id }, (value) =>
              prepareTaskControl(value, action),
            ),
        ).pipe(
          Command.withDescription(
            action === "skip-next"
              ? "Skip exactly the next execution"
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

            yield* runTaskCommand(runtime, { action: "inspect", id }, (value) =>
              prepareTaskControl(value, "snooze", undefined, at),
            );
          }),
      ).pipe(Command.withDescription("Delay the next execution until a later absolute time")),
      Command.make(
        "add",
        {
          name: Argument.String("name"),
          monitor: Flag.Boolean("monitor").pipe(
            Flag.withDescription(
              "Establish a quiet baseline, then notify only on observed value changes; requires --cron",
            ),
            Flag.atMost(1),
            Flag.map(([value = false]) => value),
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
          coding: codingFlag,
          skill: skillFlag,
          discordThread: Flag.String("discord-thread").pipe(
            Flag.withSchema(Schema.NonEmptyString.check(Schema.isPattern(/^[0-9]{1,20}$/))),
            Flag.withDescription("Send each completed result to this authorized Discord thread"),
            Flag.atMost(1),
            Flag.map(([value]) => value),
          ),
          telegramChat: Flag.String("telegram-chat").pipe(
            Flag.withSchema(Schema.NonEmptyString.check(Schema.isPattern(/^[1-9][0-9]{0,15}$/))),
            Flag.withDescription(
              "Send each completed result to the configured owner's private Telegram chat",
            ),
            Flag.atMost(1),
            Flag.map(([value]) => value),
          ),
          whatsappChat: Flag.String("whatsapp-chat").pipe(
            Flag.withSchema(Schema.String.check(Schema.isPattern(/^[1-9]\d{6,14}$/))),
            Flag.withDescription(
              "Send each completed result to the configured WhatsApp owner phone",
            ),
            Flag.atMost(1),
            Flag.map(([value]) => value),
          ),
          prompt: textArgument("prompt"),
        },
        ({
          name,
          monitor,
          at,
          cron,
          tz,
          coding,
          prompt,
          skill,
          discordThread,
          telegramChat,
          whatsappChat,
        }) =>
          Effect.gen(function* () {
            const schedule = yield* taskOperation(() => parseTaskSchedule(at, cron, tz));

            if (
              [discordThread, telegramChat, whatsappChat].filter((value) => value !== undefined)
                .length > 1
            )
              return yield* Effect.fail(
                new TaskError({ message: "Choose only one messaging destination." }),
              );

            const delivery =
              discordThread !== undefined
                ? { adapter: "discord", conversationId: discordThread }
                : telegramChat !== undefined
                  ? { adapter: "telegram", conversationId: telegramChat }
                  : whatsappChat !== undefined
                    ? { adapter: "whatsapp", conversationId: whatsappChat }
                    : undefined;

            const command = yield* prepareTask(
              name,
              schedule,
              coding,
              prompt,
              skill,
              delivery,
              monitor,
            );

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
      ...(["show", "pause", "resume", "cancel", "retry"] as const).map((action) =>
        Command.make(
          action,
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
              cancel: "Cancel pending or active work",
              retry: "Explicitly retry an unsuccessful occurrence",
            }[action],
          ),
        ),
      ),
    ]),
  );
};
