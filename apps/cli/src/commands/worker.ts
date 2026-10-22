import { AppConfig, dataDirectory as configuredDataDirectory } from "@poppet/config";
import type { WorkerAction } from "@poppet/platform";
import { WorkerConnections, remoteTaskCommand, readLocalTaskStatus } from "@poppet/tasks";
import { workerSocketPath } from "@poppet/worker";
import { Console, Effect } from "effect";
import { Command } from "effect/cli";

import type { CLIContext } from "#src/commands/context";

export const workerCommand = (context: CLIContext) => {
  const { runtime, worker, startWorker } = context;

  const runWorkerCommand = (action: WorkerAction) => {
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
        return yield* Console.log(
          JSON.stringify({ launchAgent: managed, worker: reply.value }, null, 2),
        );

      const overview = yield* readLocalTaskStatus.pipe(Effect.provide(runtime.tasks));

      const ids = [...new Set([config.provider, ...overview.providers])];

      const connections = yield* WorkerConnections.use((service) =>
        Effect.forEach(ids, (id) => service.status(id)),
      ).pipe(Effect.provide(runtime.connections));

      yield* Console.log(
        JSON.stringify(
          {
            launchAgent: managed,
            worker: {
              ...overview,
              running: false,
              pid: null,
              startedAt: null,
              activeOccurrence: null,
              connections,
            },
          },
          null,
          2,
        ),
      );
    }).pipe(Effect.provide(runtime.config));
  };

  return Command.make("worker").pipe(
    Command.withDescription("Run and manage the background worker"),
    Command.withSubcommands([
      Command.make("run", {}, () => startWorker("all")).pipe(
        Command.withDescription("Run scheduling and messaging in one foreground worker"),
      ),
      ...(["install", "start", "stop", "status", "logs", "uninstall"] as const).map((action) =>
        Command.make(action, {}, () => runWorkerCommand(action)).pipe(
          Command.withDescription(
            {
              install: "Install and start the macOS login worker",
              start: "Start an installed worker",
              stop: "Stop it until the next login or explicit start",
              status: "Show launch agent, scheduling, and connection status",
              logs: "Print the last 64 KiB of worker logs",
              uninstall: "Stop and remove login startup; retain saved data",
            }[action],
          ),
        ),
      ),
    ]),
  );
};
