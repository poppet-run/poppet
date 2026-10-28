import { AppConfig } from "@poppet/config";
import {
  makeTaskWorker,
  TaskDeliveries,
  TaskDestinations,
  TaskError,
  taskResponse,
} from "@poppet/tasks";
import { serveWorker, workerSocketPath, WorkerRequests } from "@poppet/worker";
import { Clock, Console, Effect, Option } from "effect";

import { MessagingWorker } from "#src/channels";
import { serveWebhooks } from "#src/webhooks";

/** Serves commands and runs scheduling, plus messaging when provided, until shutdown closes their shared scope. */
export const runWorker = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const commands = yield* WorkerRequests;
    const tasks = yield* makeTaskWorker;
    const messaging = Option.getOrNull(yield* Effect.serviceOption(MessagingWorker));
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
                  "Start worker run without --tasks-only before selecting a messaging destination.",
              }),
            ),
    };

    yield* serveWebhooks.pipe(Effect.provideService(TaskDestinations, destinations));

    yield* serveWorker(workerSocketPath(config.dataDirectory), (request, body) => {
      if (new URL(request.url).pathname !== "/v1/tasks") return commands.handle(request, body);

      return taskResponse(body, (command) =>
        Effect.gen(function* () {
          const value = yield* tasks.handle(command);

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
            services: { tasks: true, gateway: messaging !== null },
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

    yield* Effect.all([tasks.run, messaging?.run ?? Effect.never], {
      concurrency: 2,
      discard: true,
    });
  }),
);
