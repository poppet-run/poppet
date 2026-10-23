import { Agent, Skills } from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { LearningReviews } from "@poppet/memory";
import { Store } from "@poppet/store";
import {
  executeLocalTaskCommand,
  makeTaskWorker,
  TaskRepository,
  TaskDestinations,
  TaskError,
  taskResponse,
} from "@poppet/tasks";
import { serveWorker, workerSocketPath, WorkerRequests } from "@poppet/worker";
import { Clock, Console, Effect, Option } from "effect";

import { MessagingWorker } from "#src/channels";

/** Selects the background loops while keeping one worker endpoint and store owner. */
export type WorkerMode = "all" | "tasks" | "gateway";

/** Serves commands and runs the selected loops until shutdown closes their shared scope. */
export const runWorker = (mode: WorkerMode) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const commands = yield* WorkerRequests;
      const tasks = mode === "gateway" ? null : yield* makeTaskWorker;
      const messaging = Option.getOrNull(yield* Effect.serviceOption(MessagingWorker));
      const services = yield* Effect.context<Store | TaskRepository | Skills>();
      const startedAt = yield* Clock.currentTimeMillis;
      const agent = Option.getOrNull(yield* Effect.serviceOption(Agent));
      const reviews = Option.getOrNull(yield* Effect.serviceOption(LearningReviews));

      // Background review: reviews interrupted by a previous crash stay uncertain, never replayed.
      const reviewing =
        agent?.reviewNext === undefined || reviews === null
          ? Effect.never
          : Effect.gen(function* () {
              yield* reviews.recover.pipe(Effect.catch(() => Effect.void));

              while (true) if (!(yield* agent.reviewNext!)) yield* Effect.sleep("30 seconds");
            });

      const destinations: TaskDestinations["Service"] = {
        resolve: (adapter, conversationId) =>
          messaging !== null
            ? messaging
                .resolveDestination(adapter, conversationId)
                .pipe(Effect.mapError((error) => new TaskError({ message: error.message })))
            : Effect.fail(
                new TaskError({
                  message:
                    "Start worker run or gateway work before selecting a messaging destination.",
                }),
              ),
      };

      yield* serveWorker(workerSocketPath(config.dataDirectory), (request, body) => {
        if (!["/tasks", "/project-tasks"].includes(new URL(request.url).pathname))
          return commands.handle(request, body);

        return taskResponse(body, (command) =>
          Effect.gen(function* () {
            const value =
              tasks === null
                ? yield* executeLocalTaskCommand(command).pipe(Effect.provide(services))
                : yield* tasks.handle(command);

            if (command.action !== "status") return value;

            return {
              ...value,
              running: true,
              pid: process.pid,
              startedAt,
              services: { tasks: tasks !== null, gateway: messaging !== null },
            };
          }).pipe(Effect.provideService(TaskDestinations, destinations)),
        );
      });
      yield* Console.log(
        "Worker running. Use commands in another terminal; Ctrl-C stops the worker.",
      );

      yield* Effect.all([tasks?.run ?? Effect.never, messaging?.run ?? Effect.never, reviewing], {
        concurrency: 3,
        discard: true,
      });
    }),
  );
