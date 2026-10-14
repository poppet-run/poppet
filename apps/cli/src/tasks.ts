import { AppConfig } from "@poppet/config";
import { Store } from "@poppet/store";
import { Console, Effect, Schema } from "effect";

import {
  TaskCommand,
  TaskError,
  nextOccurrence,
  parseTimestamp,
  type Schedule,
} from "#src/task-schema";
import { TaskRepository, type TaskStore } from "#src/task-store";

export const taskOperation = <A>(operation: () => A): Effect.Effect<A, TaskError> =>
  Effect.try({
    try: operation,
    catch: (cause) =>
      cause instanceof TaskError
        ? cause
        : new TaskError({ message: "Could not read or update scheduled tasks." }),
  });

export const parseTaskCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const action = args[0];

    if ((action === "list" || action === "providers" || action === "clear") && args.length === 1)
      return { action } satisfies TaskCommand;

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
            "Use tasks add, list, show, pause, resume, cancel, retry, clear, providers, resume-provider, or work. See --help.",
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

export const executeTaskCommand = (
  repo: TaskStore,
  store: Store["Service"],
  command: TaskCommand,
  now: number,
) =>
  Effect.gen(function* () {
    if (command.action === "show") {
      const job = yield* taskOperation(() => repo.task(command.id));
      const occurrences = yield* taskOperation(() => repo.occurrences(job.id));

      const results = yield* Effect.forEach(occurrences, (item) =>
        (item.runId === null ? Effect.succeed(null) : store.run(item.runId)).pipe(
          Effect.map((run) => ({
            ...item,
            output: run?.result?.output ?? null,
            failureReason: run?.failureReason ?? null,
          })),
        ),
      );

      return {
        task: job,
        occurrences: results,
        skipped: yield* taskOperation(() => repo.skips(job.id)),
      };
    }

    return yield* taskOperation(() => {
      switch (command.action) {
        case "add":
          return repo.add(command.task, now);
        case "list":
          return repo.list();
        case "clear":
          return { cleared: repo.clear() };
        case "providers":
          return repo.providers();
        case "pause":
          return repo.pause(command.id, now);
        case "resume":
          return repo.resume(command.id, now);
        case "cancel":
          return repo.cancel(command.id, now);
        case "retry":
          return repo.retry(command.id, now);
        case "resume-provider":
          repo.resumeProvider(command.provider, now);

          return { provider: command.provider, resumed: true };
      }
    });
  });

export const localTaskCommand = (command: TaskCommand) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const repo = yield* TaskRepository;
    yield* taskOperation(() => repo.recover(Date.now()));
    const result = yield* executeTaskCommand(repo, store, command, Date.now());
    yield* Console.log(JSON.stringify(result, null, 2));
  });
