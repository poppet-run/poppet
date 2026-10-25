import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { type WorkerAction, WorkerError, type WorkerLaunch } from "@poppet/platform";
import {
  manageWorker as manageLinuxWorker,
  userConfigHome as linuxConfigHome,
} from "@poppet/platform-linux";
import { manageWorker as manageMacOSWorker } from "@poppet/platform-macos";
import { Effect } from "effect";

export const workerLaunch = (dataDirectory: string): WorkerLaunch => ({
  dataDirectory,
  executable: process.execPath,
  arguments: [fileURLToPath(new URL("./worker-background.ts", import.meta.url)), "worker", "run"],
  workingDirectory: process.cwd(),
  // Settings are read from config.json at startup; shell overrides remain local to the caller.
  environment: new Map([["POPPET_DATA_DIR", dataDirectory]]),
});

export const manageWorker = (action: WorkerAction, dataDirectory: string) =>
  process.platform === "darwin"
    ? manageMacOSWorker(action, workerLaunch(dataDirectory), homedir())
    : process.platform === "linux"
      ? manageLinuxWorker(
          action,
          workerLaunch(dataDirectory),
          linuxConfigHome(homedir(), process.env.XDG_CONFIG_HOME),
        )
      : action === "status"
        ? Effect.succeed(null)
        : Effect.fail(
            new WorkerError({
              message:
                "Background worker management currently supports macOS and Linux with systemd. Use worker run and worker status on other platforms.",
            }),
          );
