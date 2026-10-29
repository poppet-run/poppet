import { createHash } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { readBoundedText } from "@poppet/io";
import {
  prepareWorkerLog,
  readWorkerLogs,
  regularFileInfo,
  WorkerError,
  type WorkerAction,
  type WorkerLaunch,
  type WorkerStatus,
} from "@poppet/platform";
import { Effect } from "effect";

/** The completed `systemctl --user` invocation; stderr explains failures such as a missing user bus. */
export interface SystemctlRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type Systemctl = (args: ReadonlyArray<string>) => Promise<SystemctlRun>;

/** Follows the XDG rule that relative `XDG_CONFIG_HOME` values are ignored. */
export const userConfigHome = (home: string, configured: string | undefined) =>
  configured !== undefined && isAbsolute(configured) ? configured : join(home, ".config");

export const workerPaths = (launch: WorkerLaunch, configHome: string) => {
  const id = createHash("sha256").update(launch.dataDirectory).digest("hex").slice(0, 12);
  const unit = `run.poppet.worker.${id}.service`;

  return {
    unit,
    units: join(configHome, "systemd", "user"),
    file: join(configHome, "systemd", "user", unit),
    logs: join(launch.dataDirectory, "logs"),
    log: join(launch.dataDirectory, "logs", "worker.log"),
  };
};

const plainText = (value: string) => {
  // Unit files are line-based; a control character could end a setting early.
  // eslint-disable-next-line no-control-regex -- The check targets control characters.
  if (/[\u0000-\u001f\u007f]/.test(value))
    throw new WorkerError({ message: "Worker settings cannot contain control characters." });

  return value;
};

/** Escapes specifiers, which systemd expands in every setting this unit writes. */
const specifierText = (value: string) => plainText(value).replaceAll("%", "%%");

/** Quotes a value for settings that apply C-style unescaping to double-quoted words. */
const quotedText = (value: string) =>
  `"${specifierText(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export const workerUnit = (launch: WorkerLaunch) => {
  const command = [launch.executable, ...launch.arguments]
    // ExecStart also expands $NAME and ${NAME}; $$ is a literal dollar sign.
    .map((argument) => quotedText(argument).replaceAll("$", () => "$$"))
    .join(" ");

  const environment = Array.from(launch.environment, ([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new WorkerError({ message: `Invalid worker environment name: ${key}.` });

    return `Environment=${quotedText(`${key}=${value}`)}\n`;
  }).join("");

  return `[Unit]
Description=Poppet worker

[Service]
Type=exec
ExecStart=${command}
WorkingDirectory=${specifierText(launch.workingDirectory)}
${environment}Restart=always
RestartSec=30
TimeoutStopSec=30
KillMode=mixed
UMask=0077

[Install]
WantedBy=default.target
`;
};

const outputTooLarge = () => new WorkerError({ message: "systemctl output exceeded 64 KiB." });

export const runSystemctl: Systemctl = async (args) => {
  const subprocess = Bun.spawn(["systemctl", "--user", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 35_000,
    killSignal: "SIGKILL",
  });

  const [stdout, stderr, code] = await Promise.all([
    readBoundedText(subprocess.stdout, 65_536, outputTooLarge),
    readBoundedText(subprocess.stderr, 65_536, outputTooLarge),
    subprocess.exited,
  ]);

  return { code, stdout, stderr };
};

const properties = (stdout: string) =>
  new Map(
    stdout.split("\n").flatMap((line) => {
      const separator = line.indexOf("=");

      return separator === -1 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]];
    }),
  );

const failure = (args: ReadonlyArray<string>, run: SystemctlRun, detail: string) => {
  const bus = /Failed to connect to .*bus/i.test(run.stderr);

  return new WorkerError({
    message: bus
      ? "systemctl --user could not reach this user's systemd instance. Run it from a login session, or set XDG_RUNTIME_DIR for this user."
      : `systemctl ${args[0]} failed (exit ${run.code}). ${detail}`,
  });
};

export const manageWorker = (
  action: WorkerAction,
  launch: WorkerLaunch,
  configHome: string,
  systemctl: Systemctl = runSystemctl,
) => {
  const operation = Effect.tryPromise({
    try: async () => {
      const paths = workerPaths(launch, configHome);

      if (action === "logs") return await readWorkerLogs(paths.log);

      const installed = (await regularFileInfo(paths.file)) !== null;
      const inspectArgs = ["show", "--property=LoadState,ActiveState", paths.unit];
      const inspection = await systemctl(inspectArgs);

      // A missing unit reports LoadState=not-found with exit 0; other failures leave its state unknown.
      if (inspection.code !== 0)
        throw failure(
          inspectArgs,
          inspection,
          "The worker state could not be checked; its registration was retained.",
        );

      const state = properties(inspection.stdout);
      const loaded = state.get("LoadState") === "loaded";
      const activeState = state.get("ActiveState") ?? "inactive";
      const active = activeState !== "inactive" && activeState !== "failed";

      if (action === "status") {
        const status: WorkerStatus = { installed, active, file: paths.file, log: paths.log };

        return status;
      }

      const command = async (args: ReadonlyArray<string>) => {
        const run = await systemctl(args);

        if (run.code !== 0)
          throw failure(
            args,
            run,
            `Check worker status and worker logs. The service file is ${paths.file}.`,
          );
      };

      // A unit file written while the manager was running is unknown until it reloads.
      if (
        installed &&
        !loaded &&
        (action === "start" || action === "restart" || action === "uninstall")
      )
        await command(["daemon-reload"]);

      if (action === "stop" || action === "uninstall") {
        if (action === "uninstall" && installed) {
          await command(["disable", "--now", paths.unit]);
          await unlink(paths.file);
          await command(["daemon-reload"]);
        } else if (active) {
          await command(["stop", paths.unit]);
        }

        return action === "stop"
          ? "Worker stopped. It will start again at login; worker uninstall disables that."
          : "Worker uninstalled. Tasks, results, credentials, and logs were retained.";
      }

      if (action === "install") {
        if (installed)
          throw new WorkerError({
            message:
              "This worker is already installed. Uninstall it before changing its saved settings.",
          });
        const contents = workerUnit(launch);
        await mkdir(paths.units, { recursive: true });
        await prepareWorkerLog(paths.logs, paths.log);

        const unit = await open(paths.file, "wx", 0o600);

        try {
          await unit.writeFile(contents);
          await unit.sync();
        } finally {
          await unit.close();
        }

        await command(["daemon-reload"]);
        await command(["enable", "--now", paths.unit]);
      } else if (!installed) {
        throw new WorkerError({ message: "Install the worker first with worker install." });
      } else {
        // Only an explicit restart interrupts an active unit.
        await command([action === "restart" ? "restart" : "start", paths.unit]);
      }

      if (action === "restart") return "Worker restarted. Check worker status for readiness.";

      return "Worker started. It will run at login while this user is logged in. Check worker status for readiness.";
    },
    catch: (cause) =>
      cause instanceof WorkerError
        ? cause
        : new WorkerError({
            message:
              "Could not manage the background worker. Check that systemd is available and check its service file and log permissions.",
          }),
  });

  // Let lifecycle mutations finish before interruption can report the command as stopped.
  return action === "status" || action === "logs"
    ? operation
    : operation.pipe(Effect.uninterruptible);
};
