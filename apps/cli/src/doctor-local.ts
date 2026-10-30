import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { isMissingFile, runBounded } from "@poppet/io";
import { readContextFile } from "@poppet/memory";
import { workerPaths as linuxPaths, userConfigHome } from "@poppet/platform-linux";
import { workerPaths as macPaths } from "@poppet/platform-macos";
import type { ProviderRegistration } from "@poppet/provider";
import { Effect } from "effect";

import { finding } from "#src/doctor-report";
import { workerLaunch } from "#src/worker";

export const fileInfo = (path: string) =>
  lstat(path).catch((cause: unknown) => {
    if (isMissingFile(cause)) return null;
    throw cause;
  });

export const inspectAuthentication = (directory: string, provider: ProviderRegistration) =>
  Effect.gen(function* () {
    if (provider.inspectSaved === undefined)
      return finding(
        "authentication",
        "error",
        "not-checked",
        "This provider has no read-only credential inspector.",
        "Run poppet provider status.",
        true,
      );
    const saved = yield* provider.inspectSaved(directory);

    if (!saved.connected)
      return finding(
        "authentication",
        "warning",
        saved.source,
        "Credentials are missing or sign-in is incomplete.",
        `Run poppet provider login ${provider.id}.`,
      );

    if (saved.expiresAt !== null && saved.expiresAt <= Date.now())
      return finding(
        "authentication",
        "warning",
        saved.source,
        "Saved access token has expired; refresh was not attempted.",
        `Normal requests may refresh it; run poppet provider login ${provider.id} if refresh fails.`,
      );

    return finding(
      "authentication",
      "ok",
      saved.source,
      "Credentials are present; current provider access is unverified.",
    );
  });

export const inspectService = (directory: string) =>
  Effect.tryPromise(async (signal) => {
    const launch = workerLaunch(directory);
    const mac = macPaths(launch, homedir());
    const linux = linuxPaths(launch, userConfigHome(homedir(), process.env.XDG_CONFIG_HOME));

    if (process.platform !== "darwin" && process.platform !== "linux")
      return finding(
        "worker.service",
        "skipped",
        "not-checked",
        "No supported platform service manager.",
      );
    const darwin = process.platform === "darwin";
    const info = await fileInfo(darwin ? mac.plist : linux.file);

    if (info !== null && (!info.isFile() || info.isSymbolicLink()))
      throw new Error("Invalid service file");

    const args = darwin
      ? ["/bin/launchctl", "print", `gui/${process.getuid?.()}/${mac.label}`]
      : ["systemctl", "--user", "show", "--property=LoadState,ActiveState", linux.unit];

    const run = await runBounded(
      Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
      {
        signal,
        timeout: 1800,
        maxBytes: 65536,
        tooLarge: () => new Error("Service output limit"),
      },
    );

    if (run.expired || run.aborted || (run.code !== 0 && !(darwin && run.code === 113)))
      throw new Error("Service inspection failed");

    const active = darwin
      ? run.code === 0
      : /^ActiveState=(active|activating|reloading)$/m.test(run.stdout);

    if (info === null)
      return finding(
        "worker.service",
        "skipped",
        "local",
        active
          ? "Service is registered without an installed file; socket readiness is checked separately."
          : "No background service is installed; foreground use is supported.",
      );

    return finding(
      "worker.service",
      active ? "ok" : "warning",
      "local",
      active
        ? "Background service is registered and active; socket readiness is checked separately."
        : "Installed background service is stopped.",
      active ? null : "Run poppet worker start.",
    );
  });

export const inspectContext = (directory: string) =>
  Effect.tryPromise(async () => {
    await Promise.all(
      ["soul.md", "profile.md"].map(async (name) => {
        await readContextFile(join(directory, name), 8192);
      }),
    );

    return finding(
      "context",
      "ok",
      "local",
      "Profile and personality files are absent or readable within their size limits. No skill is selected by doctor.",
    );
  });
