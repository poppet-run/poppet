import { Skills } from "@poppet/agent";
import { AppConfig } from "@poppet/config";
import { Store } from "@poppet/store";
import {
  executeLocalTaskCommand,
  makeTaskWorker,
  TaskRepository,
  TaskDeliveries,
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
      const deliveries = Option.getOrNull(yield* Effect.serviceOption(TaskDeliveries));
      const startedAt = yield* Clock.currentTimeMillis;

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
        if (new URL(request.url).pathname !== "/v1/tasks") return commands.handle(request, body);

        return taskResponse(body, (command) =>
          Effect.gen(function* () {
            const value =
              tasks === null
                ? yield* executeLocalTaskCommand(command).pipe(Effect.provide(services))
                : yield* tasks.handle(command);

            if (command.action !== "status") return value;

            const messagingStatus =
              messaging === null
                ? { running: false, enabled: false, channels: [] }
                : {
                    running: true,
                    ...(yield* messaging.status.pipe(
                      Effect.mapError((error) => new TaskError({ message: error.message })),
                    )),
                  };

            return {
              ...value,
              running: true,
              pid: process.pid,
              startedAt,
              services: { tasks: tasks !== null, gateway: messaging !== null },
              messaging: messagingStatus,
            };
          }).pipe(
            Effect.provideService(TaskDestinations, destinations),
            deliveries === null
              ? (effect) => effect
              : Effect.provideService(TaskDeliveries, deliveries),
          ),
        );
      });
      yield* Console.log(
        "Worker running. Use commands in another terminal; Ctrl-C stops the worker.",
      );

      yield* Effect.all([tasks?.run ?? Effect.never, messaging?.run ?? Effect.never], {
        concurrency: 2,
        discard: true,
      });
    }),
  );
