import { isDeepStrictEqual } from "node:util";

import {
  AgentError,
  ChatSettings,
  ChatTasks,
  Skills,
  type ChatTaskAction,
  type ChatTaskContext,
} from "@poppet/agent";
import { Store, StoreError, type Run } from "@poppet/store";
import { Clock, Effect, Layer, Match, Schema } from "effect";

import { bounded, detailsOutput, listOutput, summary } from "#src/task-output";
import {
  NewTask,
  nextOccurrence,
  parseTimestamp,
  TaskError,
  TaskPatch,
  type Task,
  type TaskControl,
} from "#src/task-schema";
import { TaskRepository } from "#src/task-store";

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

const resolveDelivery = (
  delivery: Extract<ChatTaskAction, { action: "create" }>["delivery"],
  context: ChatTaskContext,
) => {
  if (delivery === "local") return Effect.succeed(null);

  const target = Match.value(delivery).pipe(
    Match.when("here", () => context.here),
    Match.when("home", () => context.home),
    Match.orElse(({ conversationId }) => context.destination?.(conversationId)),
  );

  if (target == null)
    return Effect.fail(
      new AgentError({
        reason: "tool-permission",
        message:
          "This destination requires an authorized messaging gateway. Use local in CLI chat.",
      }),
    );

  return target.pipe(
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
};

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

    const taskOutput = (action: string, task: Task) =>
      bounded(JSON.stringify({ action, task: summary(task), truncated: false }), toolBytes);

    const control = (change: TaskControl) =>
      Effect.gen(function* () {
        const receipt = yield* repo
          .control(change, clock.currentTimeMillisUnsafe())
          .pipe(
            Effect.mapError(
              (cause) => new StoreError({ reason: "invalid-request", message: cause.message }),
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
      });

    const prepareCreate = (
      action: Extract<ChatTaskAction, { action: "create" }>,
      run: Run,
      context: ChatTaskContext,
    ) =>
      Effect.gen(function* () {
        const input = yield* Effect.try({
          try: () => {
            const schedule =
              action.schedule.type === "once"
                ? { type: "once" as const, at: parseTimestamp(action.schedule.at) }
                : action.schedule;

            const now = clock.currentTimeMillisUnsafe();

            if (schedule.type === "once" && schedule.at <= now)
              throw new TaskError({
                message: "Choose a future one-off time with an explicit UTC offset.",
              });
            nextOccurrence(schedule, now);

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

        const skill = action.skill === null ? null : yield* skills.load(action.skill);
        const destination = yield* resolveDelivery(action.delivery, context);

        return Effect.gen(function* () {
          const now = clock.currentTimeMillisUnsafe();

          if (input.schedule.type === "once" && input.schedule.at <= now)
            return yield* new StoreError({
              reason: "invalid-request",
              message: "The requested one-off time has passed. Choose a future time.",
            });

          return yield* taskOutput(action.action, yield* repo.add(input, now, skill, destination));
        });
      });

    const prepareEdit = (action: Extract<ChatTaskAction, { action: "edit" }>) =>
      Effect.gen(function* () {
        const current = yield* repo.task(action.id).pipe(Effect.mapError(invalid));

        const patch = yield* Effect.try({
          try: () => {
            const fields: Record<string, Schema.Json> = {};

            if (action.name !== null) fields.name = action.name;

            if (action.prompt !== null) fields.prompt = action.prompt;

            if (action.schedule !== null)
              fields.schedule =
                action.schedule.type === "once"
                  ? { type: "once", at: parseTimestamp(action.schedule.at) }
                  : action.schedule;

            const decoded = Schema.decodeUnknownSync(TaskPatch, { onExcessProperty: "error" })(
              fields,
            );

            const schedule = decoded.schedule;
            const now = clock.currentTimeMillisUnsafe();

            if (schedule !== undefined) {
              nextOccurrence(schedule, now);

              // An unchanged past one-off is allowed; choosing a new past time is not.
              if (
                schedule.type === "once" &&
                schedule.at <= now &&
                !isDeepStrictEqual(schedule, current.schedule)
              )
                throw new TaskError({
                  message: "Choose a future one-off time with an explicit UTC offset.",
                });
            }

            return decoded;
          },
          catch: invalid,
        });

        return control({ action: "edit", id: action.id, patch });
      });

    // Each branch validates now and returns the operation to execute under the commit lock.
    const prepareAction = (
      action: ChatTaskAction,
      run: Run,
      context: ChatTaskContext,
    ): Effect.Effect<Effect.Effect<string, StoreError | TaskError>, AgentError> =>
      Effect.gen(function* () {
        if ("id" in action && action.action !== "edit")
          yield* repo.task(action.id).pipe(Effect.mapError(invalid));

        switch (action.action) {
          case "create":
            return yield* prepareCreate(action, run, context);
          case "edit":
            return yield* prepareEdit(action);
          case "list":
            yield* repo.listPage(action.after).pipe(Effect.mapError(invalid));

            return repo
              .listPage(action.after)
              .pipe(Effect.flatMap((rows) => listOutput(rows, toolBytes)));
          case "show":
            return Effect.gen(function* () {
              const task = yield* repo.task(action.id);
              const rows = yield* repo.occurrences(task.id, 6);
              const target = yield* repo.nextTarget(task.id);

              return yield* detailsOutput(task, rows, target, toolBytes);
            });
          case "pause":
          case "resume": {
            const update = action.action === "pause" ? repo.pause : repo.resume;

            return Effect.suspend(() => update(action.id, clock.currentTimeMillisUnsafe())).pipe(
              Effect.flatMap((task) => taskOutput(action.action, task)),
            );
          }

          case "snooze": {
            const until = yield* Effect.try({
              try: () => parseTimestamp(action.until),
              catch: invalid,
            });

            return control({ action: "snooze", id: action.id, until });
          }

          case "skip_next":
            return control({ action: "skip-next", id: action.id });
          case "run_now":
            return control({ action: "run-now", id: action.id });
        }
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

          const operation = yield* prepareAction(action, run, context);

          const execute = store
            .commitToolCall(
              context.runId,
              context.callId,
              operation.pipe(Effect.mapError(committedFailure)),
            )
            .pipe(repo.commandLock.withPermit);

          return { execute };
        }),
    } satisfies ChatTasks["Service"];
  }),
);
