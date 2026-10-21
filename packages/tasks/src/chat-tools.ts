import { AgentError, ChatSettings, ChatTasks, Skills } from "@poppet/agent";
import { Store, StoreError, type DeliveryDestination, type SkillSnapshot } from "@poppet/store";
import { Clock, Effect, Layer, Match, Schema } from "effect";

import { NewTask, nextOccurrence, parseTimestamp, TaskError, type Task } from "#src/task-schema";
import { TaskRepository } from "#src/task-store";

const summary = (task: Task) => ({
  id: task.id,
  name: task.name,
  monitor: task.monitor,
  schedule:
    task.schedule.type === "once"
      ? { type: "once", at: new Date(task.schedule.at).toISOString() }
      : task.schedule,
  paused: task.paused,
  nextAt: task.nextAt === null ? null : new Date(task.nextAt).toISOString(),
  destination:
    task.destination === null
      ? null
      : { adapter: task.destination.adapter, conversationId: task.destination.conversationId },
});

const bounded = (output: string, limit: number) => {
  if (Buffer.byteLength(output) > limit)
    throw new StoreError({
      reason: "invalid-request",
      message: "Task details exceed the tool-result budget. Increase POPPET_TOOL_BYTES.",
    });

  return output;
};

const invalid = (cause: unknown) =>
  new AgentError({
    reason: "tool-arguments",
    message: cause instanceof TaskError ? cause.message : "Invalid task request.",
  });

/** The shared repository lock serializes chat mutations with worker commands, without entering the agent again. */
export const ChatTasksLive = Layer.effect(
  ChatTasks,
  Effect.gen(function* () {
    const repo = yield* TaskRepository;
    const store = yield* Store;
    const skills = yield* Skills;
    const clock = yield* Clock.Clock;
    const { toolBytes } = yield* ChatSettings;

    // The host builds this layer under the new store owner, before starting agent or scheduler work.
    yield* Effect.try({
      try: () => repo.recover(clock.currentTimeMillisUnsafe()),
      catch: () =>
        new AgentError({
          reason: "tool-storage",
          message: "Could not recover scheduled task state.",
        }),
    });

    return {
      prepare: (action, context) =>
        Effect.gen(function* () {
          if (context.origin !== "interactive")
            return yield* Effect.fail(
              new AgentError({
                reason: "tool-permission",
                message: "Scheduled runs cannot manage tasks.",
              }),
            );
          const run = yield* store.run(context.runId);

          const saved = (yield* store.toolCalls(context.runId)).find(
            (call) => call.callId === context.callId,
          );

          if (run === null || saved?.name !== "manage_tasks" || saved.namespace !== "poppet_tasks")
            return yield* Effect.fail(
              new AgentError({
                reason: "tool-permission",
                message: "Task tools require the current run's recorded call.",
              }),
            );

          if (saved.status === "completed")
            return { name: "manage_tasks" as const, execute: Effect.succeed(saved.output!) };

          if (run.status !== "running")
            return yield* Effect.fail(
              new AgentError({
                reason: "tool-permission",
                message: "The task request is no longer active.",
              }),
            );

          let input: NewTask | null = null;
          let skill: SkillSnapshot | null = null;
          let destination: DeliveryDestination | null = null;

          if ("schedule" in action) {
            input = yield* Effect.try({
              try: () => {
                const schedule =
                  action.schedule.type === "once"
                    ? { type: "once" as const, at: parseTimestamp(action.schedule.at) }
                    : action.schedule;

                if (action.action === "create_monitor" && schedule.type !== "cron")
                  throw new TaskError({
                    message: "Monitoring requires a recurring cron schedule and timezone.",
                  });

                if (schedule.type === "once" && schedule.at <= clock.currentTimeMillisUnsafe())
                  throw new TaskError({
                    message: "Choose a future one-off time with an explicit UTC offset.",
                  });

                if (schedule.type === "cron")
                  nextOccurrence(schedule, clock.currentTimeMillisUnsafe());

                return Schema.decodeUnknownSync(NewTask)({
                  name: action.name,
                  prompt: action.prompt,
                  schedule,
                  provider: run.provider,
                  model: run.model,
                  workload: run.workload,
                });
              },
              catch: invalid,
            });

            if (action.skill !== null) skill = yield* skills.load(action.skill);

            if (action.delivery === "here") {
              if (context.here === null)
                return yield* Effect.fail(
                  new AgentError({
                    reason: "tool-permission",
                    message:
                      "Delivery here requires the current authorized messaging conversation. Use local in CLI chat.",
                  }),
                );
              destination = yield* context.here.pipe(
                Effect.timeoutOrElse({
                  duration: "8 seconds",
                  orElse: () =>
                    Effect.fail(
                      new AgentError({
                        reason: "tool-permission",
                        message: "Current-conversation validation timed out.",
                      }),
                    ),
                }),
              );
            }
          } else {
            yield* Effect.try({
              try: () =>
                action.action === "list" ? repo.listPage(action.after) : repo.task(action.id),
              catch: invalid,
            });
          }

          const execute = store
            .commitToolCall(context.runId, context.callId, () => {
              const now = clock.currentTimeMillisUnsafe();

              if ("schedule" in action) {
                const valid = input!;

                if (valid.schedule.type === "once" && valid.schedule.at <= now)
                  throw new StoreError({
                    reason: "invalid-request",
                    message: "The requested one-off time has passed. Choose a future time.",
                  });

                const task = repo.add(
                  valid,
                  now,
                  skill,
                  destination,
                  {
                    runId: context.runId,
                    callId: context.callId,
                  },
                  action.action === "create_monitor",
                );

                return bounded(
                  JSON.stringify({
                    action: action.action,
                    task: summary(task),
                    baseline: task.monitor ? "pending-first-success" : null,
                    truncated: false,
                  }),
                  toolBytes,
                );
              }

              if (action.action === "list") {
                const rows = repo.listPage(action.after);
                const tasks: ReturnType<typeof summary>[] = [];

                for (const task of rows.slice(0, 10)) {
                  const result = summary(task);

                  if (
                    Buffer.byteLength(
                      JSON.stringify({
                        tasks: [...tasks, result],
                        nextCursor: task.id,
                        truncated: true,
                      }),
                    ) > toolBytes
                  )
                    break;
                  tasks.push(result);
                }

                if (tasks.length === 0 && rows.length > 0)
                  return bounded(
                    JSON.stringify({
                      tasks: [summary(rows[0]!)],
                      nextCursor: rows[0]!.id,
                      truncated: true,
                    }),
                    toolBytes,
                  );
                const truncated = rows.length > tasks.length;

                return JSON.stringify({
                  tasks,
                  nextCursor: truncated ? tasks.at(-1)!.id : null,
                  truncated,
                });
              }

              const task = Match.value(action).pipe(
                Match.when({ action: "pause" }, ({ id }) => repo.pause(id, now)),
                Match.when({ action: "resume" }, ({ id }) => repo.resume(id, now)),
                Match.orElse(({ id }) => repo.task(id)),
              );

              if (action.action !== "show")
                return bounded(
                  JSON.stringify({ action: action.action, task: summary(task), truncated: false }),
                  toolBytes,
                );

              const rows = repo.occurrences(task.id, 6);

              let occurrences = rows.slice(0, 5).map((item) => ({
                id: item.id,
                status: item.status,
                scheduledAt: item.scheduledAt,
                finishedAt: item.finishedAt,
                reason: item.reason,
                monitoring: repo.monitoring.result(item.id),
              }));

              let lastObservation = repo.monitoring.latest(task.id);
              let prompt = [...task.prompt];
              let truncated = rows.length > 5;

              const output = () =>
                JSON.stringify({
                  task: {
                    ...summary(task),
                    prompt: prompt.join(""),
                    provider: task.provider,
                    model: task.model,
                    workload: task.workload,
                    skill: task.skill?.name ?? null,
                  },
                  occurrences,
                  lastObservation,
                  truncated,
                });

              while (
                Buffer.byteLength(output()) > toolBytes &&
                (prompt.length > 0 || occurrences.length > 0 || lastObservation !== null)
              ) {
                truncated = true;

                if (prompt.length > 0) prompt = prompt.slice(0, Math.floor(prompt.length / 2));
                else if (occurrences.length > 0) occurrences = occurrences.slice(0, -1);
                else lastObservation = null;
              }

              return bounded(output(), toolBytes);
            })
            .pipe(repo.commandLock.withPermit);

          return { name: "manage_tasks" as const, execute };
        }),
    } satisfies ChatTasks["Service"];
  }),
);
