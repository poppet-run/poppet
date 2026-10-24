import { AppConfig } from "@poppet/config";
import {
  remoteTaskCommand,
  executeLocalTaskCommand,
  TaskCommand,
  TaskError,
  nextOccurrence,
  parseTimestamp,
  taskOperation,
  type Schedule,
} from "@poppet/tasks";
import { workerSocketPath } from "@poppet/worker";
import { Console, Effect, Option, Schema } from "effect";

import type { CLIContext } from "#src/commands/context";

export const runTaskCommand = (runtime: CLIContext["runtime"], command: TaskCommand) =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const reply = yield* remoteTaskCommand(workerSocketPath(config.dataDirectory), command);

    const result =
      reply !== null
        ? reply.value
        : yield* executeLocalTaskCommand(command).pipe(Effect.provide(runtime.tasks));

    yield* Console.log(JSON.stringify(result, null, 2));
  }).pipe(Effect.provide(runtime.config));

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
  delivery?: { readonly adapter: string; readonly conversationId: string | null },
) =>
  Effect.gen(function* () {
    yield* taskOperation(() => {
      return nextOccurrence(schedule, Date.now());
    });
    const config = yield* AppConfig;

    if (config.model === null)
      return yield* Effect.fail(
        new TaskError({
          message: "Set model in config.json before adding a task.",
        }),
      );

    const command = {
      action: "add",
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

    return yield* Schema.decodeUnknownEffect(TaskCommand)(
      skill === undefined ? selected : { ...selected, skill },
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
