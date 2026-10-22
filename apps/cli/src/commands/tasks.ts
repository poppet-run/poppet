import { AppConfig } from "@poppet/config";
import { ProviderId } from "@poppet/provider";
import { Session } from "@poppet/store";
import {
  remoteTaskCommand,
  executeLocalTaskCommand,
  TaskCommand,
  TaskPatch,
  NewTask,
  TaskInspection,
  parseTimestamp,
  TaskError,
  taskOperation,
} from "@poppet/tasks";
import { workerSocketPath } from "@poppet/worker";
import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { codingFlag, projectFlag, skillFlag, textArgument } from "#src/commands/flags";
import { parseTaskSchedule, prepareTask, prepareTaskControl } from "#src/tasks";

export const tasksCommand = (context: CLIContext) => {
  const { runtime, startWorker } = context;

  const runTasks = (
    command: TaskCommand,
    prepare?: (inspection: typeof TaskInspection.Type) => TaskCommand,
  ) =>
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const reply = yield* remoteTaskCommand(workerSocketPath(config.dataDirectory), command);

      if (reply !== null) {
        if (prepare === undefined) return yield* Console.log(JSON.stringify(reply.value, null, 2));

        const mutation = yield* taskOperation(() =>
          prepare(Schema.decodeUnknownSync(TaskInspection)(reply.value)),
        );

        const changed = yield* remoteTaskCommand(workerSocketPath(config.dataDirectory), mutation);

        if (changed === null)
          return yield* Effect.fail(
            new TaskError({
              message:
                "The inspected worker stopped. Inspect the task again; the command was not retried locally.",
            }),
          );

        return yield* Console.log(JSON.stringify(changed.value, null, 2));
      }

      const result = yield* Effect.gen(function* () {
        const inspected = yield* executeLocalTaskCommand(command);

        return prepare === undefined
          ? inspected
          : yield* executeLocalTaskCommand(
              yield* taskOperation(() =>
                prepare(Schema.decodeUnknownSync(TaskInspection)(inspected)),
              ),
            );
      }).pipe(Effect.provide(runtime.tasks));

      yield* Console.log(JSON.stringify(result, null, 2));
    }).pipe(Effect.provide(runtime.config));

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

            yield* runTasks({ action: "inspect", id }, (value) =>
              prepareTaskControl(value, "edit", patch),
            );
          }),
      ).pipe(Command.withDescription("Edit a task's name, prompt or complete schedule")),
      ...(["skip-next", "run-now"] as const).map((action) =>
        Command.make(
          action,
          { id: Argument.String("task").pipe(Argument.withSchema(Session.fields.id)) },
          ({ id }) =>
            runTasks({ action: "inspect", id }, (value) => prepareTaskControl(value, action)),
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

            yield* runTasks({ action: "inspect", id }, (value) =>
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
          project: projectFlag,
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
          project,
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
              project,
            );

            yield* runTasks(command);
          }).pipe(Effect.provide(runtime.config)),
      ).pipe(
        Command.withDescription("Schedule a request"),
        Command.withExamples([
          { command: 'bun run start tasks add Later --at 2099-10-15T09:00:00Z "Review notes"' },
          {
            command:
              'bun run start tasks add Daily --cron "0 9 * * *" --tz Europe/London "Review notes"',
          },
        ]),
      ),
      ...(["list", "providers", "clear", "status"] as const).map((action) =>
        Command.make(action, {}, () => runTasks({ action })).pipe(
          Command.withDescription(
            {
              list: "List saved tasks",
              providers: "Show provider quota pauses and temporary backoff",
              clear: "Interrupt active work and remove all tasks and task history",
              status: "Show task counts, recent outcomes, and worker status",
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
          ({ id }) => runTasks({ action, id }),
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
      Command.make(
        "resume-provider",
        {
          provider: Argument.String("provider").pipe(Argument.withSchema(ProviderId)),
        },
        ({ provider }) => runTasks({ action: "resume-provider", provider }),
      ).pipe(Command.withDescription("Allow scheduled requests again")),
      Command.make("work", {}, () => startWorker("tasks")).pipe(
        Command.withDescription("Run scheduling only in the foreground"),
      ),
    ]),
  );
};
