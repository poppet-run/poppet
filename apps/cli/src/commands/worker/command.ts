import { AppConfig, dataDirectory as configuredDataDirectory } from "@poppet/config";
import type { WorkerAction } from "@poppet/platform";
import { WorkerConnections, remoteTaskCommand, readLocalTaskStatus } from "@poppet/tasks";
import { workerSocketPath } from "@poppet/worker";
import { Console, Effect } from "effect";
import { Command } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { jsonFlag } from "#src/commands/flags";
import { stoppedMessagingStatus } from "#src/commands/gateway/channels";
import { renderWorkerStatus, WorkerStatusReport } from "#src/commands/worker/format";
import { printParsed } from "#src/output";

export const workerCommand = (context: CLIContext) => {
  const { runtime, worker, startWorker, channels } = context;

  const runWorkerCommand = (action: WorkerAction, json = false) => {
    if (action === "stop" || action === "uninstall" || action === "logs")
      return configuredDataDirectory.pipe(
        Effect.flatMap((directory) => worker(action, directory)),
        Effect.flatMap(Console.log),
      );

    return Effect.gen(function* () {
      const config = yield* AppConfig;
      const managed = yield* worker(action, config.dataDirectory);

      if (action !== "status") return yield* Console.log(managed);

      const reply = yield* remoteTaskCommand(workerSocketPath(config.dataDirectory), {
        action: "status",
      });

      if (reply !== null)
        return yield* printParsed(
          json,
          { service: managed, worker: reply.value },
          WorkerStatusReport,
          renderWorkerStatus,
        );

      const overview = yield* readLocalTaskStatus.pipe(Effect.provide(runtime.tasks));

      const messaging = yield* stoppedMessagingStatus(channels).pipe(
        Effect.provide(runtime.messagingStatus),
      );

      const ids = [...new Set([config.provider, ...overview.providers])];

      const connections = yield* WorkerConnections.use((service) =>
        Effect.forEach(ids, (id) => service.status(id)),
      ).pipe(Effect.provide(runtime.connections));

      yield* printParsed(
        json,
        {
          service: managed,
          worker: {
            ...overview,
            running: false,
            pid: null,
            startedAt: null,
            activeOccurrence: null,
            connections,
            messaging,
          },
        },
        WorkerStatusReport,
        renderWorkerStatus,
      );
    }).pipe(Effect.provide(runtime.config));
  };

  return Command.make("worker").pipe(
    Command.withDescription("Run and manage the background worker"),
    Command.withSubcommands([
      Command.make("run", {}, () => startWorker()).pipe(
        Command.withDescription("Run scheduling and messaging in one foreground worker"),
      ),
      Command.make("status", { json: jsonFlag }, ({ json }) =>
        runWorkerCommand("status", json),
      ).pipe(
        Command.withDescription("Show login service, scheduling, provider, and messaging status"),
      ),
      ...(["install", "start", "restart", "stop", "logs", "uninstall"] as const).map((action) =>
        Command.make(action, {}, () => runWorkerCommand(action)).pipe(
          Command.withDescription(
            {
              install: "Install and start the login worker",
              start: "Start an installed worker",
              restart: "Restart an installed worker, interrupting active work",
              stop: "Stop it until the next login or explicit start",
              logs: "Print the last 64 KiB of worker logs",
              uninstall: "Stop and remove login startup; retain saved data",
            }[action],
          ),
        ),
      ),
    ]),
  );
};
