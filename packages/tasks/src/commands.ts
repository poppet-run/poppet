import { Skills } from "@poppet/agent";
import { DeliveryDestination, Store } from "@poppet/store";
import { Context, Effect, Option } from "effect";

import { TaskCommand, TaskError } from "#src/task-schema";
import { TaskRepository, type TaskStore } from "#src/task-store";

/** Host resolves an explicit remote conversation without coupling tasks to an adapter. */
export class TaskDestinations extends Context.Service<
  TaskDestinations,
  {
    readonly resolve: (
      adapter: string,
      conversationId: string,
    ) => Effect.Effect<DeliveryDestination, TaskError>;
  }
>()("poppet/TaskDestinations") {}

export const taskOperation = <A>(operation: () => A): Effect.Effect<A, TaskError> =>
  Effect.try({
    try: operation,
    catch: (cause) =>
      cause instanceof TaskError
        ? cause
        : new TaskError({ message: "Could not read or update scheduled tasks." }),
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
        Effect.gen(function* () {
          const run = item.runId === null ? null : yield* store.run(item.runId);
          const delivery = yield* taskOperation(() => repo.deliveries(item.id));

          return {
            ...item,
            delivery,
            output: run?.result?.output ?? null,
            failureReason: run?.failureReason ?? null,
          };
        }),
      );

      return {
        task: job,
        occurrences: results,
        skipped: yield* taskOperation(() => repo.skips(job.id)),
      };
    }

    if (command.action === "add") {
      const name = command.skill;

      const skill =
        name === undefined
          ? null
          : yield* Skills.use((skills) => skills.load(name)).pipe(
              Effect.mapError((error) => new TaskError({ message: error.message })),
            );

      const resolver = yield* Effect.serviceOption(TaskDestinations);

      if (command.delivery && Option.isNone(resolver))
        return yield* Effect.fail(
          new TaskError({
            message: "Start worker run or gateway work before selecting a messaging destination.",
          }),
        );

      const destination =
        command.delivery && Option.isSome(resolver)
          ? yield* resolver.value.resolve(command.delivery.adapter, command.delivery.conversationId)
          : null;

      return yield* taskOperation(() => repo.add(command.task, now, skill, destination));
    }

    return yield* taskOperation(() => {
      switch (command.action) {
        case "list":
          return repo.list();
        case "status":
          return repo.status();
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

const recoveredTasks = Effect.gen(function* () {
  const repo = yield* TaskRepository;
  yield* taskOperation(() => repo.recover(Date.now()));

  return repo;
});

export const readLocalTaskStatus = recoveredTasks.pipe(
  Effect.flatMap((repo) => taskOperation(() => repo.status())),
);

export const executeLocalTaskCommand = (command: TaskCommand) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const repo = yield* recoveredTasks;

    return yield* executeTaskCommand(repo, store, command, Date.now());
  });
