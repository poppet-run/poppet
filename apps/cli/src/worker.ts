import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { type WorkerAction, WorkerError, type WorkerLaunch } from "@poppet/platform";
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
    : Effect.fail(
        new WorkerError({
          message:
            "Background worker management currently supports macOS. Use worker run and tasks status on other platforms.",
        }),
      );
