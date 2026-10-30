import { AppConfig, ConfigIdentity } from "@poppet/config";
import {
  makeTaskWorker,
  TaskDeliveries,
  TaskDestinations,
  TaskError,
  taskResponse,
} from "@poppet/tasks";
import { serveWorker, workerSocketPath, WorkerRequests } from "@poppet/worker";
import { Clock, Console, Effect, Option } from "effect";
import { SqlClient } from "effect/sql";

import { MessagingWorker } from "#src/channels";
import { doctorSnapshot, gatewayObservation } from "#src/doctor-worker";

/** Serves commands and runs scheduling and messaging until shutdown closes their shared scope. */
export const runWorker = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const commands = yield* WorkerRequests;
    const tasks = yield* makeTaskWorker;
    const messaging = yield* MessagingWorker;
    const deliveries = Option.getOrNull(yield* Effect.serviceOption(TaskDeliveries));
    const startedAt = yield* Clock.currentTimeMillis;
    const identity = Option.getOrNull(yield* Effect.serviceOption(ConfigIdentity));
    const sql = yield* SqlClient.SqlClient;

    const destinations: TaskDestinations["Service"] = {
      resolve: (adapter, conversationId) =>
        messaging
          .resolveDestination(adapter, conversationId)
          .pipe(Effect.mapError((error) => new TaskError({ message: error.message }))),
    };

    yield* serveWorker(workerSocketPath(config.dataDirectory), (request, body) => {
      if (new URL(request.url).pathname === "/v1/doctor")
        return (
          identity === null
            ? Effect.fail(new Error("Configuration identity unavailable"))
            : doctorSnapshot(identity)
        ).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.flatMap((snapshot) =>
            messaging.status.pipe(
              Effect.map((status) => ({ ...snapshot, gateway: gatewayObservation(status) })),
            ),
          ),
          Effect.timeout("2 seconds"),
          Effect.match({
            onSuccess: (snapshot) => Response.json(snapshot),
            onFailure: () => Response.json({ version: 1, unavailable: true }, { status: 503 }),
          }),
        );

      if (new URL(request.url).pathname !== "/v1/tasks") return commands.handle(request, body);

      return taskResponse(body, (command) =>
        Effect.gen(function* () {
          const value = yield* tasks.handle(command);

          if (command.action !== "status") return value;

          const messagingStatus = {
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
            services: { tasks: true, gateway: true },
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

    yield* Effect.all([tasks.run, messaging.run], {
      concurrency: 2,
      discard: true,
    });
  }),
);
