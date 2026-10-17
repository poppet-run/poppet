import { AppConfig } from "@poppet/config";
import {
  TaskCommand,
  TaskError,
  nextOccurrence,
  parseTimestamp,
  taskOperation,
  type Schedule,
} from "@poppet/tasks";
import { Effect, Option, Schema } from "effect";

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
) =>
  Effect.gen(function* () {
    yield* taskOperation(() => nextOccurrence(schedule, Date.now()));
    const config = yield* AppConfig;

    if (config.model === null)
      return yield* Effect.fail(
        new TaskError({
          message: "Set model in config.json or POPPET_MODEL before adding a task.",
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
              "Use a nonempty task name up to 128 bytes, a prompt up to 16384 bytes, and a model ID up to 1024 bytes, with no surrounding whitespace. Run bun run start --help.",
          }),
      ),
    );
  });
