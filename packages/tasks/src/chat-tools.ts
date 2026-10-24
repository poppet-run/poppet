import { isDeepStrictEqual } from "node:util";

import { AgentError, ChatSettings, ChatTasks, Skills } from "@poppet/agent";
import { Store, StoreError, type DeliveryDestination, type SkillSnapshot } from "@poppet/store";
import { Clock, Effect, Layer, Match, Schema } from "effect";

import {
  NewTask,
  nextOccurrence,
  parseTimestamp,
  TaskError,
  TaskControl,
  type Task,
} from "#src/task-schema";
import { TaskRepository } from "#src/task-store";

const summary = (task: Task) => ({
  id: task.id,
  name: task.name,
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

const bounded = (output: string, limit: number) =>
  Buffer.byteLength(output) > limit
    ? Effect.fail(
        new StoreError({
          reason: "invalid-request",
          message: "Task details exceed the tool-result budget. Increase POPPET_TOOL_BYTES.",
        }),
      )
    : Effect.succeed(output);

// Task failures inside a committed operation surface as storage failures, as before.
const committedFailure = (cause: StoreError | TaskError) =>
  cause instanceof StoreError
    ? cause
    : new StoreError({
        reason: "storage",
        message: "Poppet could not read or write its conversation store.",
      });

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
    yield* repo.recover(clock.currentTimeMillisUnsafe()).pipe(
      Effect.mapError(
        () =>
          new AgentError({
            reason: "tool-storage",
            message: "Could not recover scheduled task state.",
          }),
      ),
    );

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

          if (saved.status === "completed") return { execute: Effect.succeed(saved.output!) };

          if (run.status !== "running")
            return yield* Effect.fail(
              new AgentError({
                reason: "tool-permission",
                message: "The task request is no longer active.",
              }),
            );

          const session = yield* store.session(run.sessionId);

          if (session === null)
            return yield* Effect.fail(
              new AgentError({
                reason: "tool-permission",
                message: "The owning session no longer exists.",
              }),
            );

          let input: NewTask | null = null;
          let skill: SkillSnapshot | null = null;
          let destination: DeliveryDestination | null = null;
          let change: TaskControl | null = null;

          if ("delivery" in action) {
            input = yield* Effect.try({
              try: () => {
                const schedule =
                  action.schedule.type === "once"
                    ? { type: "once" as const, at: parseTimestamp(action.schedule.at) }
                    : action.schedule;

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

            if (action.delivery !== "local") {
              const target = Match.value(action.delivery).pipe(
                Match.when("here", () => context.here),
                Match.when("home", () => context.home),
                Match.orElse(({ conversationId }) => context.destination?.(conversationId)),
              );

              if (target == null)
                return yield* Effect.fail(
                  new AgentError({
                    reason: "tool-permission",
                    message:
                      "This destination requires an authorized messaging gateway. Use local in CLI chat.",
                  }),
                );
              destination = yield* target.pipe(
                Effect.timeoutOrElse({
                  duration: "8 seconds",
                  orElse: () =>
                    Effect.fail(
                      new AgentError({
                        reason: "tool-permission",
                        message: "Messaging destination validation timed out.",
                      }),
                    ),
                }),
              );
            }
          } else {
            if (action.action === "list")
              yield* repo.listPage(action.after).pipe(Effect.mapError(invalid));
            else yield* repo.task(action.id).pipe(Effect.mapError(invalid));

            if (
              action.action === "edit" ||
              action.action === "skip_next" ||
              action.action === "snooze" ||
              action.action === "run_now"
            ) {
              change = yield* Effect.try({
                try: () => {
                  if (action.action === "edit") {
                    const patch: Record<string, Schema.Json> = {};

                    if (action.name !== null) patch.name = action.name;

                    if (action.prompt !== null) patch.prompt = action.prompt;

                    if (action.schedule !== null)
                      patch.schedule =
                        action.schedule.type === "once"
                          ? { type: "once", at: parseTimestamp(action.schedule.at) }
                          : action.schedule;

                    return Schema.decodeUnknownSync(TaskControl, { onExcessProperty: "error" })({
                      id: action.id,
                      action: "edit",
                      patch,
                    });
                  }

                  if (action.action === "snooze")
                    return {
                      id: action.id,
                      action: "snooze" as const,
                      until: parseTimestamp(action.until),
                    };

                  return {
                    id: action.id,
                    action:
                      action.action === "skip_next" ? ("skip-next" as const) : ("run-now" as const),
                  };
                },
                catch: invalid,
              });

              if (change.action === "edit" && change.patch.schedule !== undefined) {
                const schedule = change.patch.schedule;

                yield* Effect.try({
                  try: () => nextOccurrence(schedule, clock.currentTimeMillisUnsafe()),
                  catch: invalid,
                });

                // An unchanged past one-off is allowed; choosing a new past time is not.
                if (schedule.type === "once" && schedule.at <= clock.currentTimeMillisUnsafe()) {
                  const current = yield* repo.task(change.id).pipe(Effect.mapError(invalid));

                  if (!isDeepStrictEqual(schedule, current.schedule))
                    return yield* Effect.fail(
                      invalid(
                        new TaskError({
                          message: "Choose a future one-off time with an explicit UTC offset.",
                        }),
                      ),
                    );
                }
              }
            }
          }

          const commit = Effect.gen(function* () {
            const now = clock.currentTimeMillisUnsafe();

            if ("delivery" in action) {
              const valid = input!;

              if (valid.schedule.type === "once" && valid.schedule.at <= now)
                return yield* new StoreError({
                  reason: "invalid-request",
                  message: "The requested one-off time has passed. Choose a future time.",
                });

              const task = yield* repo.add(valid, now, skill, destination);

              return yield* bounded(
                JSON.stringify({ action: action.action, task: summary(task), truncated: false }),
                toolBytes,
              );
            }

            if (change !== null) {
              const receipt = yield* repo
                .control(change, now)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new StoreError({ reason: "invalid-request", message: cause.message }),
                  ),
                );

              return yield* bounded(
                JSON.stringify({
                  ...receipt,
                  task: summary(yield* repo.task(change.id)),
                  truncated: false,
                }),
                toolBytes,
              );
            }

            if (action.action === "list") {
              const rows = yield* repo.listPage(action.after);
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
                return yield* bounded(
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

            const task = yield* Match.value(action).pipe(
              Match.when({ action: "pause" }, ({ id }) => repo.pause(id, now)),
              Match.when({ action: "resume" }, ({ id }) => repo.resume(id, now)),
              Match.orElse(({ id }) => repo.task(id)),
            );

            if (action.action !== "show")
              return yield* bounded(
                JSON.stringify({ action: action.action, task: summary(task), truncated: false }),
                toolBytes,
              );

            const rows = yield* repo.occurrences(task.id, 6);
            const target = yield* repo.nextTarget(task.id);

            let occurrences = rows.slice(0, 5).map((item) => ({
              id: item.id,
              status: item.status,
              scheduledAt: item.scheduledAt,
              availableAt: item.availableAt,
              origin: item.origin,
              finishedAt: item.finishedAt,
              reason: item.reason,
            }));

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
                target,
                truncated,
              });

            while (
              Buffer.byteLength(output()) > toolBytes &&
              (prompt.length > 0 || occurrences.length > 0)
            ) {
              truncated = true;

              if (prompt.length > 0) prompt = prompt.slice(0, Math.floor(prompt.length / 2));
              else if (occurrences.length > 0) occurrences = occurrences.slice(0, -1);
            }

            return yield* bounded(output(), toolBytes);
          }).pipe(Effect.mapError(committedFailure));

          const execute = store
            .commitToolCall(context.runId, context.callId, commit)
            .pipe(repo.commandLock.withPermit);

          return { execute };
        }),
    } satisfies ChatTasks["Service"];
  }),
);
