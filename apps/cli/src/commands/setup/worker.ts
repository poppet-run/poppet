import { remoteTaskCommand } from "@poppet/tasks";
import { workerSocketPath } from "@poppet/worker";
import { Console, Effect, Schema } from "effect";
import { Prompt } from "effect/cli";

import type { CLIContext } from "#src/commands/context";
import { UsageError } from "#src/commands/errors";

export type WorkerState = "unmanaged" | "foreground" | "active" | "installed" | "absent";

export const workerState = (context: CLIContext, directory: string) =>
  Effect.gen(function* () {
    const managed = yield* context.worker("status", directory);

    if (managed === null) {
      return "unmanaged" as const;
    }

    const status = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ installed: Schema.Boolean, active: Schema.Boolean }),
    )(managed).pipe(
      Effect.mapError(() => new UsageError({ message: "Unexpected worker status." })),
    );

    const running = yield* remoteTaskCommand(workerSocketPath(directory), { action: "status" });

    return running !== null && !status.active
      ? ("foreground" as const)
      : status.active
        ? ("active" as const)
        : status.installed
          ? ("installed" as const)
          : ("absent" as const);
  });

export const describeWorker = (state: WorkerState) =>
  ({
    unmanaged: "not managed by setup on this system",
    foreground: "running in the foreground",
    active: "installed and running",
    installed: "installed but stopped",
    absent: "not installed",
  })[state];

export const setupWorker = (context: CLIContext, directory: string, state: WorkerState) =>
  Effect.gen(function* () {
    if (state === "unmanaged") {
      yield* Console.log("Start scheduling and messaging with: poppet worker run");

      return;
    }

    if (state === "foreground") {
      yield* Console.log(
        "A foreground worker is running. Stop it and run poppet worker run again to apply these settings.",
      );

      return;
    }

    const action = { active: "restart", installed: "start", absent: "install" } as const;

    const message = {
      active: "Restart the worker to apply these settings? This can interrupt active runs.",
      installed: "Start the installed worker for scheduling and messaging?",
      absent: "Install and start the login worker for scheduling and messaging?",
    };

    if (yield* Prompt.Confirm({ message: message[state], initial: false })) {
      yield* Console.log(yield* context.worker(action[state], directory));
      yield* Console.log("Run poppet worker status to check readiness.");
    } else {
      yield* Console.log(
        state === "active"
          ? "Restart the worker when ready to apply these settings: poppet worker restart"
          : "Start scheduling and messaging when ready: poppet worker run",
      );
    }
  });
