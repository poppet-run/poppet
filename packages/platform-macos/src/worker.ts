import { createHash } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";

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

export const workerPaths = (launch: WorkerLaunch, home: string) => {
  const id = createHash("sha256").update(launch.dataDirectory).digest("hex").slice(0, 12);
  const label = `run.poppet.worker.${id}`;

  return {
    label,
    plist: join(home, "Library", "LaunchAgents", `${label}.plist`),
    logs: join(launch.dataDirectory, "logs"),
    log: join(launch.dataDirectory, "logs", "worker.log"),
  };
};

const xmlText = (value: string) =>
  value.replace(/[<>&"']/g, (character) => {
    switch (character) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });

export const workerPlist = (launch: WorkerLaunch, home: string) => {
  const paths = workerPaths(launch, home);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xmlText(paths.label)}</string>
  <key>ProgramArguments</key><array>${[launch.executable, ...launch.arguments].map((argument) => `<string>${xmlText(argument)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${xmlText(launch.workingDirectory)}</string>
  <key>EnvironmentVariables</key><dict>${Array.from(launch.environment)
    .map(([key, value]) => `<key>${xmlText(key)}</key><string>${xmlText(value)}</string>`)
    .join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xmlText(paths.log)}</string>
  <key>StandardErrorPath</key><string>${xmlText(paths.log)}</string>
</dict></plist>
`;
};

export const runLaunchctl = async (args: ReadonlyArray<string>) => {
  const subprocess = Bun.spawn(["/bin/launchctl", ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    timeout: 35_000,
    killSignal: "SIGKILL",
  });

  return await subprocess.exited;
};

export const manageWorker = (
  action: WorkerAction,
  launch: WorkerLaunch,
  home: string,
  launchctl: (args: ReadonlyArray<string>) => Promise<number> = runLaunchctl,
) => {
  const operation = Effect.tryPromise({
    try: async () => {
      const paths = workerPaths(launch, home);

      if (action === "logs") return await readWorkerLogs(paths.log);

      const domain = `gui/${process.getuid?.()}`;
      const target = `${domain}/${paths.label}`;
      const installed = (await regularFileInfo(paths.plist)) !== null;
      const inspection = await launchctl(["print", target]);

      // 113 means this service is absent. Other failures leave its state unknown.
      if (inspection !== 0 && inspection !== 113)
        throw new WorkerError({
          message: `launchctl print failed (exit ${inspection}). The worker state could not be checked; its registration was retained.`,
        });
      const active = inspection === 0;

      if (action === "status") {
        const status: WorkerStatus = { installed, active, file: paths.plist, log: paths.log };

        return status;
      }

      const command = async (args: ReadonlyArray<string>) => {
        const exitCode = await launchctl(args);

        if (exitCode !== 0 && !(args[0] === "bootout" && exitCode === 113))
          throw new WorkerError({
            message: `launchctl ${args[0]} failed (exit ${exitCode}). Check worker status and worker logs. The service file is ${paths.plist}.`,
          });
      };

      if (action === "stop" || action === "uninstall") {
        if (active) await command(["bootout", target]);

        if (action === "uninstall" && installed) await unlink(paths.plist);

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
        const directory = join(home, "Library", "LaunchAgents");
        await mkdir(directory, { recursive: true });
        await prepareWorkerLog(paths.logs, paths.log);

        const plist = await open(paths.plist, "wx", 0o600);

        try {
          await plist.writeFile(workerPlist(launch, home));
          await plist.sync();
        } finally {
          await plist.close();
        }
      } else if (!installed) {
        throw new WorkerError({ message: "Install the worker first with worker install." });
      }

      if (action === "restart" && active) await command(["bootout", target]);

      if (!active || action === "restart") await command(["bootstrap", domain, paths.plist]);
      else await command(["kickstart", target]);

      if (action === "restart") return "Worker restarted. Check worker status for readiness.";

      return "Worker started. It will run at login while this user is logged in. Check worker status for readiness.";
    },
    catch: (cause) =>
      cause instanceof WorkerError
        ? cause
        : new WorkerError({
            message:
              "Could not manage the background worker. Check its service file and log permissions.",
          }),
  });

  // Let lifecycle mutations finish before interruption can report the command as stopped.
  return action === "status" || action === "logs"
    ? operation
    : operation.pipe(Effect.uninterruptible);
};
