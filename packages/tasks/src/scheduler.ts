import { Agent, AgentError, Skills, sessionTitle } from "@poppet/agent";
import { AppConfig, taskApprovals } from "@poppet/config";
import type { LogValue } from "@poppet/io";
import { ProviderError } from "@poppet/provider";
import { Store } from "@poppet/store";
import type { Approval, StoreError } from "@poppet/store";
import {
  Cause,
  Clock,
  Console,
  Context,
  Schema,
  Effect,
  Exit,
  Fiber,
  Logger,
  Option,
  Queue,
  Stream,
} from "effect";

import { TaskDestinations, executeTaskCommand, noAction } from "#src/commands";
import { isTaskControl, nextSlot } from "#src/task-schema";
import type { Occurrence, ProviderPause, TaskError, TaskCommand } from "#src/task-schema";
import { TaskRepository } from "#src/task-store";
import type { TaskStore } from "#src/task-store";

export class WorkerConnections extends Context.Service<
  WorkerConnections,
  {
    readonly status: (provider: string) => Effect.Effect<Schema.JsonObject>;
  }
>()("poppet/WorkerConnections") {}

const log = (
  message: string,
  fields: Readonly<Record<string, LogValue>>,
  level: "info" | "error" = "info",
) =>
  (level === "error" ? Effect.logError(message) : Effect.logInfo(message)).pipe(
    Effect.annotateLogs(fields),
  );

const occurrenceFields = (item: { id: string; jobId: string }, name: string) => ({
  task: item.jobId,
  name,
  occurrence: item.id,
});

const logProviderPause = (pause: ProviderPause) =>
  log("provider paused", {
    provider: pause.provider,
    reason: pause.reason,
    resume_at: pause.resumeAt === null ? null : new Date(pause.resumeAt).toISOString(),
  });

const logTaskEnd = (task: { name: string; jobId: string; endAt: number }) =>
  log("task ended", {
    task: task.jobId,
    name: task.name,
    end_at: new Date(task.endAt).toISOString(),
  });

export const reconcileTasks = (repo: TaskStore, now: number, startup = false) =>
  Effect.gen(function* () {
    const { skipped, ended } = yield* repo.reconcile(now, startup);

    yield* Effect.forEach(skipped, (item) =>
      log("task occurrences skipped", {
        task: item.jobId,
        name: item.name,
        from: new Date(item.firstAt).toISOString(),
        to: new Date(item.lastAt).toISOString(),
        reason: item.reason,
      }),
    );
    yield* Effect.forEach(ended, logTaskEnd);
  });

const approvalOptions = (repo: TaskStore, item: Occurrence) =>
  Effect.gen(function* () {
    const saved = yield* repo.task(item.jobId);

    const policy =
      saved.approvals ?? (yield* taskApprovals.pipe(Effect.orElseSucceed(() => "fail" as const)));

    if (policy !== "wait") {
      return {};
    }

    const destinations = Option.getOrNull(yield* Effect.serviceOption(TaskDestinations));

    const destination =
      item.destination ??
      (destinations?.home === undefined
        ? null
        : yield* destinations.home.pipe(Effect.catch(() => Effect.succeed(null))));

    if (destination === null) {
      return {};
    }

    const nextDue =
      saved.schedule.type === "cron"
        ? yield* Effect.try(() => nextSlot(saved.schedule, item.scheduledAt, saved.endAt)).pipe(
            Effect.orElseSucceed(() => null),
          )
        : null;

    return {
      approvalRequester: {
        surface: "scheduled",
        occurrenceId: item.id,
        jobId: item.jobId,
        adapter: destination.adapter,
        account: destination.account,
        ownerId: destination.ownerId,
        scopeId: destination.scopeId,
        parentId: destination.parentId,
        conversationId: destination.conversationId,
      },
      ...(nextDue !== null && { approvalExpiresAt: nextDue }),
    };
  });

export const executeOccurrence = (
  repo: TaskStore,
  item: Occurrence,
  options: { readonly resume?: boolean } = {},
) =>
  Effect.gen(function* () {
    const job = item.definition;
    const store = yield* Store;
    const agent = yield* Agent;
    const clock = yield* Clock.Clock;
    let modelFailure: AgentError | ProviderError | null = null;
    let parked: Approval | null = null;

    const saveFailure = (error: AgentError | ProviderError) =>
      Effect.sync(() => {
        modelFailure = error;
      });

    yield* Effect.gen(function* () {
      const note = yield* repo.note(item.jobId);
      const approval = yield* approvalOptions(repo, item);

      const sendOptions = {
        origin: "scheduled" as const,
        taskNote: { text: note?.text ?? null },
        ...approval,
      };

      if (options.resume) {
        if (item.runId === null) {
          return yield* Effect.die(new Error("A resumed occurrence has no run ID."));
        }

        yield* log("task occurrence resumed", {
          ...occurrenceFields(item, job.name),
          provider: job.provider,
        });

        yield* Stream.runForEach(agent.resume(item.runId, sendOptions), (event) =>
          event.type === "waiting"
            ? Effect.sync(() => {
                parked = event.approval;
              })
            : Effect.void,
        );

        return;
      }

      yield* log("task occurrence started", {
        ...occurrenceFields(item, job.name),
        provider: job.provider,
      });

      const session = yield* store.createSession(job.provider, job.model, {
        origin: "scheduled",
        taskTitle: sessionTitle(job.name),
        skill: job.skill,
      });

      yield* repo.link(item.id, session.id, null);
      yield* Stream.runForEach(agent.send(session.id, job.prompt, sendOptions), (event) => {
        if (event.type === "started") {
          return repo.link(item.id, session.id, event.run.id);
        }

        if (event.type === "waiting") {
          return Effect.sync(() => {
            parked = event.approval;
          });
        }

        return Effect.void;
      });
    }).pipe(
      Effect.catchTags({ AgentError: saveFailure, ProviderError: saveFailure }),
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (Exit.isSuccess(exit) && modelFailure === null && parked !== null) {
            yield* log("task occurrence waiting for approval", {
              ...occurrenceFields(item, job.name),
              approval: parked.id,
            });

            return;
          }

          const now = clock.currentTimeMillisUnsafe();

          const outcome = yield* Effect.gen(function* () {
            if (Exit.isSuccess(exit) && modelFailure === null) {
              const finished = yield* repo.finish(item.id, "completed", null, now);

              return { ...finished, reason: finished.occurrence.reason };
            }

            const failure = Exit.isFailure(exit)
              ? Cause.findErrorOption(exit.cause)
              : Option.none();

            const error = Option.isSome(failure) ? failure.value : modelFailure;

            const interrupted =
              (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) ||
              ((error instanceof AgentError || error instanceof ProviderError) &&
                error.reason === "interrupted");

            const pauseReason =
              error instanceof ProviderError &&
              (error.reason === "quota" ||
                error.reason === "temporary" ||
                error.reason === "rate-limit")
                ? error.reason
                : null;

            const reason =
              error instanceof ProviderError
                ? `provider:${error.reason}`
                : error instanceof AgentError
                  ? `agent:${error.reason}`
                  : interrupted
                    ? "worker-stopped"
                    : "storage";

            return {
              ...(yield* repo.finish(
                item.id,
                interrupted ? "interrupted" : "failed",
                error?.message ?? "worker-stopped",
                now,
                pauseReason,
              )),
              reason,
            };
          });

          const { status, runId } = outcome.occurrence;

          const quiet =
            status === "completed" && runId !== null && noAction(yield* store.run(runId));

          if (status !== "cancelled") {
            yield* log(
              "task occurrence finished",
              {
                ...occurrenceFields(item, job.name),
                status,
                no_action: quiet || undefined,
                note_updated: outcome.noteUpdated || undefined,
                reason: status === "failed" ? outcome.reason : undefined,
              },
              status === "failed" ? "error" : "info",
            );
          }

          if (outcome.pause !== null) {
            yield* logProviderPause(outcome.pause);
          }

          if (outcome.providerResumed) {
            yield* log("provider resumed", { provider: job.provider });
          }
        }),
      ),
    );
  });

interface ActiveOccurrence {
  readonly id: string;
  readonly fiber: Fiber.Fiber<void, TaskError | StoreError>;
}

export const makeTaskWorker = Effect.gen(function* () {
  const config = yield* AppConfig;
  const skills = yield* Skills;

  const store = yield* Store;
  const agent = yield* Agent;
  const repo = yield* TaskRepository;
  const clock = yield* Clock.Clock;
  const output = yield* Console.Console;
  const loggers = yield* Logger.CurrentLoggers;
  const wake = yield* Queue.make<void>({ capacity: 1, strategy: "dropping" });
  const commands = repo.commandLock;
  let active: ActiveOccurrence | null = null;
  const startedAt = clock.currentTimeMillisUnsafe();
  const connections = Option.getOrNull(yield* Effect.serviceOption(WorkerConnections));
  const destinations = Option.getOrNull(yield* Effect.serviceOption(TaskDestinations));

  const endWaitingRun = (runId: string | null) =>
    Effect.gen(function* () {
      if (runId === null) {
        return;
      }

      const run = yield* store.run(runId);

      if (run?.status === "waiting" || run?.status === "running") {
        yield* store.finishRun(runId, { status: "interrupted", reason: "cancelled" });
      }
    });

  // Settles finished or expired waiting occurrences and returns the first decided one ready to resume.
  const reconcileWaiting = (now: number) =>
    Effect.gen(function* () {
      yield* store.expireApprovals;
      let ready: Occurrence | null = null;

      for (const item of yield* repo.running()) {
        if (active?.id === item.id) {
          continue;
        }

        if (item.runId === null) {
          yield* repo.finish(item.id, "interrupted", "owner-stopped", now);
          continue;
        }

        const run = yield* store.run(item.runId);
        const approval = yield* store.latestApproval(item.runId);

        if (run === null) {
          yield* repo.finish(item.id, "interrupted", "owner-stopped", now);
        } else if (run.status === "waiting") {
          continue;
        } else if (
          run.status === "running" &&
          (approval?.state === "approved" || approval?.state === "denied")
        ) {
          ready ??= item;
        } else if (run.status === "completed") {
          yield* repo.finish(item.id, "completed", null, now);
        } else if (run.status === "failed") {
          const finished = yield* repo.finish(item.id, "failed", run.failureReason, now);
          yield* log(
            "task occurrence finished",
            {
              ...occurrenceFields(item, item.definition.name),
              status: finished.occurrence.status,
              reason: run.failureReason ?? undefined,
            },
            "error",
          );
        } else {
          yield* repo.finish(item.id, "interrupted", run.failureReason ?? "owner-stopped", now);
        }
      }

      return ready;
    });

  yield* reconcileTasks(repo, clock.currentTimeMillisUnsafe(), true);
  const pauses = yield* repo.providers();
  yield* Effect.forEach(
    pauses.filter(
      (pause) => pause.resumeAt === null || pause.resumeAt > clock.currentTimeMillisUnsafe(),
    ),
    logProviderPause,
  );

  const readStatus = Effect.gen(function* () {
    const overview = yield* repo.status();

    const ids = [...new Set([config.provider, ...overview.providers])];

    return {
      ...overview,
      running: true,
      pid: process.pid,
      startedAt,
      activeOccurrence: active?.id ?? null,
      connections:
        connections !== null ? yield* Effect.forEach(ids, (id) => connections.status(id)) : [],
    };
  });

  const handle = (command: TaskCommand) =>
    Effect.gen(function* () {
      const now = clock.currentTimeMillisUnsafe();

      if (command.action === "status") {
        return yield* readStatus;
      }

      if (command.action === "clear") {
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (active !== null) {
              yield* Fiber.interrupt(active.fiber);
            }

            for (const item of yield* repo.running()) {
              yield* endWaitingRun(item.runId);
              yield* repo.cancel(item.id, now);
            }

            const result = yield* executeTaskCommand(repo, store, command, now);
            yield* log("tasks cleared", {});

            return result;
          }),
        );
      }

      const pending =
        command.action === "pause"
          ? (yield* repo.occurrences(command.id)).filter((item) => item.status === "pending")
          : [];

      const before =
        isTaskControl(command) || command.action === "resume"
          ? Option.getOrNull(yield* Effect.option(repo.task(command.id)))
          : null;

      const result = yield* executeTaskCommand(repo, store, command, now);

      if (
        isTaskControl(command) ||
        command.action === "delete" ||
        command.action === "clear-note"
      ) {
        yield* log("task updated", { task: command.id, action: command.action });
      }

      if (command.action === "pause" || command.action === "resume") {
        const job = yield* repo.task(command.id);
        yield* log(command.action === "pause" ? "task paused" : "task resumed", {
          task: job.id,
          name: job.name,
        });
        yield* Effect.forEach(pending, (item) =>
          log("task occurrence cancelled", {
            ...occurrenceFields(item, job.name),
            reason: "task-paused",
          }),
        );
      }

      if (before !== null && before.nextAt !== null) {
        const job = yield* repo.task(before.id);

        if (job.nextAt === null && job.endAt !== null) {
          yield* logTaskEnd({ name: job.name, jobId: job.id, endAt: job.endAt });
        }
      }

      if (command.action === "retry-task" || command.action === "cancel-task") {
        const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(result);
        const item = yield* repo.occurrence(id);
        const cancelling = command.action === "cancel-task";

        if (cancelling && active?.id === item.id) {
          yield* Fiber.interrupt(active.fiber);
        }

        if (cancelling) {
          yield* endWaitingRun(item.runId);
        }

        const job = yield* repo.task(item.jobId);
        yield* log(
          cancelling ? "task occurrence cancelled" : "task occurrence queued for retry",
          occurrenceFields(item, job.name),
        );
      }

      if (command.action === "resume-provider") {
        yield* log("provider resumed", { provider: command.provider, by: "request" });
      }

      yield* Queue.offer(wake, undefined);

      return result;
    }).pipe(
      (effect) => commands.withPermit(effect),
      Effect.provideService(Console.Console, output),
      Effect.provideService(Logger.CurrentLoggers, loggers),
      Effect.provideService(Skills, skills),
    );

  const run = Effect.scoped(
    Effect.gen(function* () {
      yield* log("task worker started", {});

      const timer = Effect.gen(function* () {
        yield* commands
          .withPermit(
            Effect.gen(function* () {
              const now = clock.currentTimeMillisUnsafe();
              yield* reconcileWaiting(now);
              yield* reconcileTasks(repo, now);
            }),
          )
          .pipe(
            Effect.andThen(Queue.offer(wake, undefined)),
            Effect.catch((error) =>
              log("task timer failed", { error: error.message }, "error").pipe(
                Effect.andThen(Effect.sleep("5 seconds")),
              ),
            ),
          );
        yield* Effect.sleep("1 second");
      }).pipe(Effect.forever);

      const worker = Effect.gen(function* () {
        yield* Queue.take(wake);

        const claimed = yield* commands
          .withPermit(
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const now = clock.currentTimeMillisUnsafe();
                const resumed = yield* reconcileWaiting(now);

                if (resumed !== null) {
                  const fiber = yield* restore(
                    executeOccurrence(repo, resumed, { resume: true }),
                  ).pipe(Effect.forkChild);

                  const running = { id: resumed.id, fiber };
                  active = running;

                  return running;
                }

                const next = yield* repo.claim(now);

                if (next === null) {
                  return null;
                }

                const fiber = yield* restore(executeOccurrence(repo, next)).pipe(Effect.forkChild);

                const running = { id: next.id, fiber };
                active = running;

                return running;
              }),
            ),
          )
          .pipe(
            Effect.catch((error) =>
              log("task worker claim failed", { error: error.message }, "error").pipe(
                Effect.andThen(Effect.sleep("5 seconds")),
                Effect.as(null),
              ),
            ),
          );

        if (claimed === null) {
          return;
        }

        const exit = yield* Fiber.await(claimed.fiber).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              active = null;
            }),
          ),
        );

        if (Exit.isFailure(exit) && !Cause.hasInterrupts(exit.cause)) {
          if (Cause.hasDies(exit.cause)) {
            return yield* exit;
          }

          const error = Option.getOrNull(Cause.findErrorOption(exit.cause));

          yield* log(
            "task occurrence storage failed",
            { occurrence: claimed.id, error: error?.message ?? "unknown" },
            "error",
          );
          yield* Effect.sleep("5 seconds");
        }

        yield* Queue.offer(wake, undefined);
      }).pipe(Effect.forever);

      yield* Effect.all([timer, worker], { concurrency: 2, discard: true });
    }),
  ).pipe(
    Effect.onExit(() => log("task worker stopped", {})),
    Effect.provideService(Store, store),
    Effect.provideService(Agent, agent),
    Effect.provideService(Clock.Clock, clock),
    Effect.provideService(Console.Console, output),
    destinations === null
      ? (effect) => effect
      : Effect.provideService(TaskDestinations, destinations),
  );

  return { run, handle };
});
