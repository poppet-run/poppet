import { Agent, AgentError, Skills, sessionTitle } from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { ProviderError } from "@poppet/provider";
import { Store, type StoreError } from "@poppet/store";
import {
  Cause,
  Clock,
  Console,
  Context,
  Schema,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Stream,
} from "effect";

import { executeTaskCommand, taskOperation } from "#src/commands";
import {
  type Occurrence,
  type ProviderPause,
  type Task,
  type TaskError,
  type TaskCommand,
} from "#src/task-schema";
import { TaskRepository, type TaskStore } from "#src/task-store";

/** Host-supplied provider status that keeps scheduling independent of concrete adapters. */
export class WorkerConnections extends Context.Service<
  WorkerConnections,
  {
    readonly status: (provider: string) => Effect.Effect<Schema.JsonObject>;
  }
>()("poppet/WorkerConnections") {}

const workerLog = (at: number, message: string, failed = false) => {
  const line = `[${new Date(at).toISOString()}] ${message}`;

  return failed ? Console.error(line) : Console.log(line);
};

const occurrenceLabel = (name: string, id: string) =>
  `Task ${JSON.stringify(name)} occurrence=${id}`;

const logProviderPause = (at: number, pause: ProviderPause) =>
  workerLog(
    at,
    `Provider ${pause.provider} paused reason=${pause.reason}; ${
      pause.resumeAt === null
        ? `use tasks resume-provider ${pause.provider}`
        : `resumes at ${new Date(pause.resumeAt).toISOString()}`
    }`,
  );

/** Reconciles due work and logs only skips committed by the repository. */
export const reconcileTasks = (repo: TaskStore, now: number, startup = false) =>
  Effect.gen(function* () {
    const skipped = yield* taskOperation(() => repo.reconcile(now, startup));

    yield* Effect.forEach(skipped, (item) =>
      workerLog(
        now,
        `Task ${JSON.stringify(item.name)} task=${item.jobId} skipped ${new Date(item.firstAt).toISOString()} to ${new Date(item.lastAt).toISOString()} reason=${item.reason}`,
      ),
    );
  });

/** Runs an occurrence in a fresh session with read-only notes, then saves its outcome. */
export const executeOccurrence = (repo: TaskStore, item: Occurrence, job: Task) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const agent = yield* Agent;
    const clock = yield* Clock.Clock;
    let modelFailure: AgentError | ProviderError | null = null;

    const saveFailure = (error: AgentError | ProviderError) =>
      Effect.sync(() => {
        modelFailure = error;
      });

    yield* Effect.gen(function* () {
      yield* workerLog(
        clock.currentTimeMillisUnsafe(),
        `${occurrenceLabel(job.name, item.id)} started provider=${job.provider}`,
      );

      // Link the fresh session before requests begin, so crash recovery can inspect it.
      const session = yield* store.createSession(job.provider, job.model, {
        workload: job.workload,
        taskTitle: sessionTitle(job.name),
        skill: job.skill,
      });

      yield* taskOperation(() => repo.link(item.id, session.id, null));
      yield* Stream.runForEach(
        agent.send(session.id, job.prompt, { readOnlyTools: true }),
        (event) =>
          taskOperation(() => {
            if (event.type === "started") repo.link(item.id, session.id, event.run.id);
          }),
      );
    }).pipe(
      // Catch model failures before finalization so a failed database write still stops the worker.
      Effect.catchTags({ AgentError: saveFailure, ProviderError: saveFailure }),
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const now = clock.currentTimeMillisUnsafe();

          const outcome = yield* taskOperation(() => {
            if (Exit.isSuccess(exit) && modelFailure === null) {
              const finished = repo.finish(item.id, "completed", null, now);

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
              ...repo.finish(
                item.id,
                interrupted ? "interrupted" : "failed",
                error?.message ?? "worker-stopped",
                now,
                pauseReason,
              ),
              reason,
            };
          });

          // Active cancellations are logged by the command after interruption finishes.
          if (outcome.occurrence.status !== "cancelled")
            yield* workerLog(
              now,
              `${occurrenceLabel(job.name, item.id)} ${outcome.occurrence.status}${outcome.occurrence.status === "failed" ? ` reason=${outcome.reason}` : ""}`,
              outcome.occurrence.status === "failed",
            );

          if (outcome.pause !== null) yield* logProviderPause(now, outcome.pause);

          if (outcome.providerResumed) yield* workerLog(now, `Provider ${job.provider} resumed`);
        }),
      ),
    );
  });

interface ActiveOccurrence {
  readonly id: string;
  readonly fiber: Fiber.Fiber<void, TaskError | StoreError>;
}

/** Recovers task state and builds serialized command handling plus the scheduling loop. */
export const makeTaskWorker = Effect.gen(function* () {
  const config = yield* AppConfig;
  const skills = yield* Skills;
  const store = yield* Store;
  const agent = yield* Agent;
  const repo = yield* TaskRepository;
  const clock = yield* Clock.Clock;
  const output = yield* Console.Console;
  const wake = yield* Queue.make<void>({ capacity: 1, strategy: "dropping" });
  const commands = repo.commandLock;
  let active: ActiveOccurrence | null = null;
  const startedAt = clock.currentTimeMillisUnsafe();
  const connections = Option.getOrNull(yield* Effect.serviceOption(WorkerConnections));

  yield* reconcileTasks(repo, clock.currentTimeMillisUnsafe(), true);
  const pauses = yield* taskOperation(() => repo.providers());
  yield* Effect.forEach(
    pauses.filter(
      (pause) => pause.resumeAt === null || pause.resumeAt > clock.currentTimeMillisUnsafe(),
    ),
    (pause) => logProviderPause(clock.currentTimeMillisUnsafe(), pause),
  );

  const readStatus = Effect.gen(function* () {
    const overview = yield* taskOperation(() => repo.status());

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

      if (command.action === "status") return yield* readStatus;

      if (command.action === "clear")
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (active !== null) yield* Fiber.interrupt(active.fiber);
            const result = yield* executeTaskCommand(repo, store, command, now);
            yield* workerLog(clock.currentTimeMillisUnsafe(), "All tasks cleared.");

            return result;
          }),
        );

      const pending =
        command.action === "pause"
          ? yield* taskOperation(() =>
              repo.occurrences(command.id).filter((item) => item.status === "pending"),
            )
          : [];

      const result = yield* executeTaskCommand(repo, store, command, now);

      if (command.action === "cancel" && active?.id === command.id)
        yield* Fiber.interrupt(active.fiber);

      if (command.action === "pause" || command.action === "resume") {
        const job = yield* taskOperation(() => repo.task(command.id));
        yield* workerLog(
          now,
          `Task ${JSON.stringify(job.name)} task=${job.id} ${command.action === "pause" ? "paused" : "resumed"}`,
        );
        yield* Effect.forEach(pending, (item) =>
          workerLog(now, `${occurrenceLabel(job.name, item.id)} cancelled reason=task-paused`),
        );
      }

      if (command.action === "retry" || command.action === "cancel") {
        const item = yield* taskOperation(() => repo.occurrence(command.id));
        const job = yield* taskOperation(() => repo.task(item.jobId));
        yield* workerLog(
          now,
          `${occurrenceLabel(job.name, item.id)} ${command.action === "retry" ? "queued for retry" : "cancelled"}`,
        );
      }

      if (command.action === "resume-provider")
        yield* workerLog(now, `Provider ${command.provider} resumed by request`);

      yield* Queue.offer(wake, undefined);

      return result;
    }).pipe(
      commands.withPermit,
      Effect.provideService(Console.Console, output),
      Effect.provideService(Skills, skills),
    );

  const run = Effect.scoped(
    Effect.gen(function* () {
      yield* workerLog(
        clock.currentTimeMillisUnsafe(),
        "Task worker running. Use tasks commands in another terminal; Ctrl-C stops the worker.",
      );

      const timer = Effect.gen(function* () {
        yield* reconcileTasks(repo, clock.currentTimeMillisUnsafe());
        yield* Queue.offer(wake, undefined);
        yield* Effect.sleep("1 second");
      }).pipe(Effect.forever);

      const worker = Effect.gen(function* () {
        yield* Queue.take(wake);

        // Claim and fork without an interruption gap that could strand a running occurrence.
        // Share command ownership while claiming so clear cannot race a new active run.
        const current = yield* commands.withPermit(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const claimed = yield* taskOperation(() =>
                repo.claim(clock.currentTimeMillisUnsafe()),
              );

              if (claimed === null) return null;

              const fiber = yield* restore(
                executeOccurrence(repo, claimed.occurrence, claimed.task),
              ).pipe(Effect.forkChild);

              const running = { id: claimed.occurrence.id, fiber };
              active = running;

              return running;
            }),
          ),
        );

        if (current === null) return;

        const exit = yield* Fiber.await(current.fiber).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              active = null;
            }),
          ),
        );

        // Explicitly cancelling a child occurrence should leave the worker available.
        if (Exit.isFailure(exit) && !Cause.hasInterrupts(exit.cause)) yield* exit;
        yield* Queue.offer(wake, undefined);
      }).pipe(Effect.forever);

      // Failure in either loop stops its sibling; the host owns the listener.
      yield* Effect.all([timer, worker], { concurrency: 2, discard: true });
    }),
  ).pipe(
    Effect.onExit(() =>
      Clock.currentTimeMillis.pipe(Effect.flatMap((now) => workerLog(now, "Task worker stopped."))),
    ),
    Effect.provideService(Store, store),
    Effect.provideService(Agent, agent),
    Effect.provideService(Clock.Clock, clock),
    Effect.provideService(Console.Console, output),
  );

  return { run, handle };
});
