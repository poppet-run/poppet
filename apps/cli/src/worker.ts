import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import type { Settings } from "@poppet/config";
import { WorkerAction, WorkerError, type WorkerLaunch } from "@poppet/platform";
import { manageWorker as manageMacOSWorker } from "@poppet/platform-macos";
import { Effect, Schema } from "effect";

export const parseWorkerCommand = (args: ReadonlyArray<string>) =>
  args.length === 1
    ? Schema.decodeUnknownEffect(WorkerAction)(args[0]).pipe(
        Effect.mapError(
          () =>
            new WorkerError({
              message: "Use worker install, start, stop, status, logs, or uninstall.",
            }),
        ),
      )
    : Effect.fail(
        new WorkerError({
          message: "Use worker install, start, stop, status, logs, or uninstall.",
        }),
      );

export const workerLaunch = (config: Settings): WorkerLaunch => {
  const environment = new Map([
    ["POPPET_APP_NAME", config.applicationName],
    ["POPPET_DATA_DIR", config.dataDirectory],
    ["POPPET_NOTES_DIR", config.notesDirectory],
    ["POPPET_PROVIDER", config.provider],
  ]);

  if (config.model !== null) environment.set("POPPET_MODEL", config.model);

  // Copy only known budgets. Shell API keys and unrelated environment values stay out of the plist.
  for (const name of [
    "CONTEXT_BYTES",
    "HISTORY_TURNS",
    "OUTPUT_TOKENS",
    "MODEL_TURNS",
    "TOOL_CALLS",
    "TOOL_BYTES",
    "PROFILE_BYTES",
    "FACTS_BYTES",
  ]) {
    const key = `POPPET_${name}`;
    const value = process.env[key];

    if (value !== undefined) environment.set(key, value);
  }

  return {
    dataDirectory: config.dataDirectory,
    executable: process.execPath,
    arguments: [fileURLToPath(new URL("./main.ts", import.meta.url)), "tasks", "work"],
    workingDirectory: process.cwd(),
    environment,
  };
};

export const manageWorker = (action: WorkerAction, config: Settings) =>
  process.platform === "darwin"
    ? manageMacOSWorker(action, workerLaunch(config), homedir())
    : Effect.fail(
        new WorkerError({
          message:
            "Background worker management currently supports macOS. Use tasks work and tasks status on other platforms.",
        }),
      );
