import { createHash } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";

import { prepareWorkerLog, readWorkerLogs, regularFileInfo, WorkerError } from "#src/index";
import type { WorkerAction, WorkerLaunch, WorkerStatus } from "#src/index";

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

const xmlText = (value: string) => {
  // eslint-disable-next-line no-control-regex -- XML 1.0 forbids these control characters.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/.test(value)) {
    throw new WorkerError({ message: "Worker settings cannot contain illegal XML characters." });
  }

  return value.replaceAll(/[<>&"']/g, (character) => {
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
};

export const workerPlist = (launch: WorkerLaunch, home: string) => {
  const paths = workerPaths(launch, home);

  const environment = Array.from(launch.environment, ([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new WorkerError({ message: `Invalid worker environment name: ${key}.` });
    }

    return `<key>${xmlText(key)}</key><string>${xmlText(value)}</string>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xmlText(paths.label)}</string>
  <key>ProgramArguments</key><array>${[launch.executable, ...launch.arguments].map((argument) => `<string>${xmlText(argument)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${xmlText(launch.workingDirectory)}</string>
  <key>EnvironmentVariables</key><dict>${environment}</dict>
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

export type Launchctl = (args: ReadonlyArray<string>, signal?: AbortSignal) => Promise<number>;

export const runLaunchctl: Launchctl = async (args, signal) => {
  const subprocess = Bun.spawn(["/bin/launchctl", ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    timeout: 35_000,
    killSignal: "SIGKILL",
    ...(signal && { signal }),
  });

  return await subprocess.exited;
};

export const manageWorker = (
  action: WorkerAction,
  launch: WorkerLaunch,
  home: string,
  launchctl: Launchctl = runLaunchctl,
) => {
  const operation = Effect.tryPromise({
    try: async (signal) => {
      const paths = workerPaths(launch, home);

      if (action === "logs") {
        return await readWorkerLogs(paths.log);
      }

      const domain = `gui/${process.getuid?.()}`;
      const target = `${domain}/${paths.label}`;
      const installed = (await regularFileInfo(paths.plist)) !== null;
      const inspection = await launchctl(["print", target], signal);

      if (inspection !== 0 && inspection !== 113) {
        throw new WorkerError({
          message: `launchctl print failed (exit ${inspection}). The worker state could not be checked; its registration was retained.`,
        });
      }

      const active = inspection === 0;

      if (action === "status") {
        const status: WorkerStatus = { installed, active, file: paths.plist, log: paths.log };

        return status;
      }

      const command = async (args: ReadonlyArray<string>) => {
        const exitCode = await launchctl(args);

        if (exitCode !== 0 && !(args[0] === "bootout" && exitCode === 113)) {
          throw new WorkerError({
            message: `launchctl ${args[0]} failed (exit ${exitCode}). Check worker status and worker logs. The service file is ${paths.plist}.`,
          });
        }
      };

      if (action === "stop" || action === "uninstall") {
        if (active) {
          await command(["bootout", target]);
        }

        if (action === "uninstall" && installed) {
          await unlink(paths.plist);
        }

        return action === "stop"
          ? "Worker stopped. It will start again at login; worker uninstall disables that."
          : "Worker uninstalled. Tasks, results, credentials, and logs were retained.";
      }

      if (action === "install") {
        if (installed) {
          throw new WorkerError({
            message:
              "This worker is already installed. Uninstall it before changing its saved settings.",
          });
        }

        const contents = workerPlist(launch, home);
        const directory = join(home, "Library", "LaunchAgents");
        await mkdir(directory, { recursive: true });
        await prepareWorkerLog(paths.logs, paths.log);

        const plist = await open(paths.plist, "wx", 0o600);

        try {
          await plist.writeFile(contents);
          await plist.sync();
          await plist.close();
        } catch (cause) {
          await plist.close().catch(() => {});
          await unlink(paths.plist).catch(() => {});
          throw cause;
        }
      } else if (!installed) {
        throw new WorkerError({ message: "Install the worker first with worker install." });
      }

      if ((action === "restart" || action === "install") && active) {
        await command(["bootout", target]);
        const deadline = performance.now() + 35_000;

        while (true) {
          const removal = await launchctl(["print", target], signal);

          if (removal === 113) {
            break;
          }

          if (removal !== 0) {
            throw new WorkerError({
              message: `launchctl print failed (exit ${removal}) while waiting for the worker to stop. Its installed configuration was retained.`,
            });
          }

          if (performance.now() >= deadline) {
            throw new WorkerError({
              message:
                "Timed out waiting for launchd to remove the worker. Check worker status and worker logs before starting it again. Its installed configuration was retained.",
            });
          }

          await Bun.sleep(100);
        }
      }

      if (!active || action === "restart" || action === "install") {
        await command(["bootstrap", domain, paths.plist]);
      } else {
        await command(["kickstart", target]);
      }

      if (action === "restart") {
        return "Worker restarted. Check worker status for readiness.";
      }

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

  return action === "status" || action === "logs"
    ? operation
    : operation.pipe(Effect.uninterruptible);
};
