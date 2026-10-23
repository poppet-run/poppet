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

/** Runs synchronous task parsing or validation, reporting unexpected failures generically. */
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
    if (command.action === "inspect") {
      const job = yield* repo.task(command.id);

      return {
        task: { id: job.id, revision: job.revision },
        target: yield* repo.nextTarget(job.id),
      };
    }

    if (command.action === "show") {
      const job = yield* repo.task(command.id);
      const occurrences = yield* repo.occurrences(job.id);

      const results = yield* Effect.forEach(occurrences, (item) =>
        Effect.gen(function* () {
          const run = item.runId === null ? null : yield* store.run(item.runId);
          const delivery = yield* repo.deliveries(item.id);

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
        target: yield* repo.nextTarget(job.id),
        changes: yield* repo.changes(job.id),
        occurrences: results,
        skipped: yield* repo.skips(job.id),
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

      const resolver = Option.getOrNull(yield* Effect.serviceOption(TaskDestinations));
      let destination: DeliveryDestination | null = null;

      if (command.delivery) {
        if (resolver === null)
          return yield* Effect.fail(
            new TaskError({
              message: "Start worker run or gateway work before selecting a messaging destination.",
            }),
          );

        destination = yield* resolver.resolve(
          command.delivery.adapter,
          command.delivery.conversationId,
        );
      }

      return yield* repo.add(command.task, now, skill, destination);
    }

    switch (command.action) {
      case "list":
        return yield* repo.list();
      case "status":
        return yield* repo.status();
      case "clear":
        return { cleared: yield* repo.clear() };
      case "providers":
        return yield* repo.providers();
      case "pause":
        return yield* repo.pause(command.id, now);
      case "resume":
        return yield* repo.resume(command.id, now);
      case "cancel":
        return yield* repo.cancel(command.id, now);
      case "retry":
        return yield* repo.retry(command.id, now);
      case "edit":
      case "skip-next":
      case "snooze":
      case "run-now":
        return yield* repo.control(command, now);
      case "resume-provider":
        yield* repo.resumeProvider(command.provider, now);

        return { provider: command.provider, resumed: true };
    }
  });

const recoveredTasks = TaskRepository.pipe(Effect.tap((repo) => repo.recover(Date.now())));

export const readLocalTaskStatus = recoveredTasks.pipe(Effect.flatMap((repo) => repo.status()));

export const executeLocalTaskCommand = (command: TaskCommand) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const repo = yield* recoveredTasks;

    return yield* executeTaskCommand(repo, store, command, Date.now());
  });
