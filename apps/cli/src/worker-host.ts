import { AppConfig } from "@poppet/config";
import { Store } from "@poppet/store";
import {
  executeLocalTaskCommand,
  makeTaskWorker,
  TaskRepository,
  taskResponse,
} from "@poppet/tasks";
import { serveWorker, workerSocketPath, WorkerRequests } from "@poppet/worker";
import { Clock, Console, Effect, Option } from "effect";

import { MessagingWorker } from "#src/channels";

export type WorkerMode = "all" | "tasks" | "gateway";

export const runWorker = (mode: WorkerMode) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const commands = yield* WorkerRequests;
      const tasks = mode === "gateway" ? null : yield* makeTaskWorker;
      const messaging = yield* Effect.serviceOption(MessagingWorker);
      const services = yield* Effect.context<Store | TaskRepository>();
      const startedAt = yield* Clock.currentTimeMillis;

      yield* serveWorker(workerSocketPath(config.dataDirectory), (request, body) => {
        if (new URL(request.url).pathname !== "/tasks") return commands.handle(request, body);

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
              services: { tasks: tasks !== null, gateway: Option.isSome(messaging) },
            };
          }),
        );
      });
      yield* Console.log(
        "Worker running. Use commands in another terminal; Ctrl-C stops the worker.",
      );

      yield* Effect.all(
        [tasks?.run ?? Effect.never, Option.isSome(messaging) ? messaging.value.run : Effect.never],
        { concurrency: 2, discard: true },
      );
    }),
  );
