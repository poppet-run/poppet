import { Skills, loadProject } from "@poppet/agent";
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
    if (command.action === "inspect")
      return yield* taskOperation(() => {
        const job = repo.task(command.id);

        return { task: { id: job.id, revision: job.revision }, target: repo.nextTarget(job.id) };
      });

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
            monitoring: yield* taskOperation(() => repo.monitoring.result(item.id)),
            output: run?.result?.output ?? null,
            failureReason: item.reason?.startsWith("monitor:")
              ? item.reason
              : (run?.failureReason ?? null),
          };
        }),
      );

      return {
        task: job,
        target: yield* taskOperation(() => repo.nextTarget(job.id)),
        changes: yield* taskOperation(() => repo.changes(job.id)),
        lastObservation: yield* taskOperation(() => repo.monitoring.latest(job.id)),
        baselineObservation: yield* taskOperation(() =>
          repo.monitoring.latest(job.id, job.monitorBaselineAfter),
        ),
        occurrences: results,
        skipped: yield* taskOperation(() => repo.skips(job.id)),
      };
    }

    if (command.action === "add" || command.action === "add-monitor") {
      const name = command.skill;

      const skill =
        name === undefined
          ? null
          : yield* Skills.use((skills) => skills.load(name)).pipe(
              Effect.mapError((error) => new TaskError({ message: error.message })),
            );

      const project =
        command.project === undefined
          ? null
          : yield* loadProject(command.project).pipe(
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

      return yield* taskOperation(() => {
        const task = repo.add(
          command.task,
          now,
          skill,
          destination,
          undefined,
          command.action === "add-monitor",
          project,
        );

        return task.monitor ? { ...task, baseline: "pending-first-success" } : task;
      });
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
        case "edit":
        case "skip-next":
        case "snooze":
        case "run-now":
          return repo.control(command, now);
        case "resume-provider":
          repo.resumeProvider(command.provider, now);

          return { provider: command.provider, resumed: true };
      }
    });
  });

const recoveredTasks = TaskRepository.pipe(
  Effect.tap((repo) => taskOperation(() => repo.recover(Date.now()))),
);

export const readLocalTaskStatus = recoveredTasks.pipe(
  Effect.flatMap((repo) => taskOperation(() => repo.status())),
);

export const executeLocalTaskCommand = (command: TaskCommand) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const repo = yield* recoveredTasks;

    return yield* executeTaskCommand(repo, store, command, Date.now());
  });
