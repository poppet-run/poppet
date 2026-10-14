import { AppConfig } from "@poppet/config";
import {
  TaskCommand,
  TaskError,
  nextOccurrence,
  parseTimestamp,
  taskOperation,
  type Schedule,
} from "@poppet/tasks";
import { Effect, Schema } from "effect";

export const parseTaskCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const action = args[0];

    if (["list", "providers", "clear", "status"].includes(action ?? "") && args.length === 1)
      return yield* Schema.decodeUnknownEffect(TaskCommand)({ action }).pipe(
        Effect.mapError(() => new TaskError({ message: "Invalid task command." })),
      );

    if (
      ["show", "pause", "resume", "cancel", "retry", "resume-provider"].includes(action ?? "") &&
      args.length === 2
    )
      return yield* Schema.decodeUnknownEffect(TaskCommand)(
        action === "resume-provider" ? { action, provider: args[1] } : { action, id: args[1] },
      ).pipe(
        Effect.mapError(
          () =>
            new TaskError({ message: "Invalid task or provider ID. Run bun run start --help." }),
        ),
      );

    if (action !== "add")
      return yield* Effect.fail(
        new TaskError({
          message:
            "Use tasks add, list, show, status, pause, resume, cancel, retry, clear, providers, resume-provider, or work. See --help.",
        }),
      );

    const name = args[1];

    const schedule = yield* taskOperation((): Schedule => {
      if (args[2] === "--at" && args[3]) return { type: "once", at: parseTimestamp(args[3]) };

      if (args[2] === "--cron" && args[3] && args[4] === "--tz" && args[5])
        return { type: "cron", expression: args[3], timezone: args[5] };

      throw new TaskError({
        message:
          "Use tasks add <name> --at <timestamp> <prompt>, or --cron <expression> --tz <timezone> <prompt>.",
      });
    });

    const offset = schedule.type === "once" ? 4 : 6;
    const coding = args[offset] === "--coding";
    yield* taskOperation(() => nextOccurrence(schedule, Date.now()));
    const config = yield* AppConfig;

    if (config.model === null)
      return yield* Effect.fail(
        new TaskError({ message: "Set POPPET_MODEL before adding a task." }),
      );

    return yield* Schema.decodeUnknownEffect(TaskCommand)({
      action,
      task: {
        name,
        schedule,
        prompt: args.slice(offset + (coding ? 1 : 0)).join(" "),
        provider: config.provider,
        model: config.model,
        workload: coding ? "coding" : "assistant",
      },
    }).pipe(
      Effect.mapError(
        () =>
          new TaskError({
            message:
              "Use a nonempty task name up to 128 bytes, a prompt up to 16384 bytes, and a model ID up to 1024 bytes, with no surrounding whitespace. Run bun run start --help.",
          }),
      ),
    );
  });
