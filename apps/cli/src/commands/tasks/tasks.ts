import { AppConfig } from "@poppet/config";
import { DeliveryDestination } from "@poppet/store";
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
import { Effect, Option, Schema } from "effect";

import type { CLIContext } from "#src/commands/context";
import { printTaskResult } from "#src/commands/tasks/format";

export const runTaskCommand = (
  runtime: CLIContext["runtime"],
  command: TaskCommand,
  json = false,
) =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const reply = yield* remoteTaskCommand(workerSocketPath(config.dataDirectory), command);

    const result =
      reply !== null
        ? reply.value
        : yield* executeLocalTaskCommand(command).pipe(Effect.provide(runtime.tasks));

    yield* printTaskResult(json, command, result);
  }).pipe(Effect.provide(runtime.config));

export const parseTaskSchedule = (
  at: Option.Option<string>,
  cron: Option.Option<string>,
  tz: Option.Option<string>,
  delay: Option.Option<string> = Option.none(),
): Schedule => {
  if (Option.isSome(delay)) {
    if (Option.isSome(at) || Option.isSome(cron) || Option.isSome(tz))
      throw new TaskError({ message: "Use --in alone, without --at, --cron, or --tz." });

    return { type: "once", at: parseRelativeTime(delay.value) };
  }

  if (Option.isSome(at) && Option.isNone(cron) && Option.isNone(tz))
    return { type: "once", at: parseTimestamp(at.value) };

  if (Option.isNone(at) && Option.isSome(cron) && Option.isSome(tz))
    return { type: "cron", expression: cron.value, timezone: tz.value };

  throw new TaskError({
    message: "Use --in <duration>, --at <timestamp>, or --cron <expression> --tz <timezone>.",
  });
};

export const prepareTask = (
  name: string,
  schedule: Schedule,
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

/** Split only the first colon; the rest belongs to the adapter's conversation ID. */
export const parseTaskDestination = (text: string | undefined) => {
  if (text === undefined) return undefined;
  const separator = text.indexOf(":");
  const adapter = separator < 0 ? text : text.slice(0, separator);
  const conversationId = separator < 0 ? null : text.slice(separator + 1);

  if (
    !Schema.is(DeliveryDestination.fields.adapter)(adapter) ||
    (conversationId !== null &&
      (conversationId.length === 0 || conversationId.trim() !== conversationId))
  )
    throw new TaskError({ message: "Use --to <gateway> or --to <gateway>:<conversation-id>." });

  return { adapter, conversationId };
};

/** Durations are elapsed time, independent of local timezone and DST transitions. */
export const parseRelativeTime = (text: string, now = Date.now()): number => {
  const match = /^([1-9][0-9]*)(s|m|h|d)$/.exec(text);

  if (match === null)
    throw new TaskError({ message: "Use a positive whole duration such as 30s, 10m, 2h, or 1d." });
  const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  // SAFETY: The regex above restricts the unit to exactly s, m, h, or d.
  const at = now + Number(match[1]) * units[match[2] as keyof typeof units];

  if (!Number.isSafeInteger(at) || at > 8_640_000_000_000_000 || at <= now)
    throw new TaskError({ message: "The duration is too large." });

  return at;
};
