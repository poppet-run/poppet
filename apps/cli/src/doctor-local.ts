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
        "Doctor cannot check saved sign-in details for this provider yet.",
        "Run poppet provider status.",
        true,
      );
    const saved = yield* provider.inspectSaved(directory);

    if (!saved.connected)
      return finding(
        "authentication",
        "warning",
        saved.source,
        "No usable sign-in details were found for this provider.",
        `Run poppet provider login ${provider.id}.`,
      );

    if (saved.expiresAt !== null && saved.expiresAt <= Date.now())
      return finding(
        "authentication",
        "warning",
        saved.source,
        "Your saved access token has expired. Poppet may renew it automatically when you next use it.",
        `If your next request fails to sign in, run poppet provider login ${provider.id}.`,
      );

    return finding(
      "authentication",
      "ok",
      saved.source,
      saved.source === "local"
        ? "An API key is set in your environment. Doctor has not tested it."
        : "Sign-in details are saved. Doctor has not contacted the provider to test them.",
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
        "Doctor cannot check background services on this operating system.",
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
          ? "The service manager knows about Poppet, but its service file is missing. Check Worker connection to see whether Poppet is responding."
          : "No background service is installed. You can still run Poppet in a terminal.",
      );

    return finding(
      "worker.service",
      active ? "ok" : "warning",
      "local",
      active
        ? "The service manager has Poppet registered. Check Worker connection to see whether it is responding."
        : "The background service is installed but is not active.",
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
      "Any existing profile.md and soul.md files are readable and within the 8 KiB limit. Doctor does not check skills.",
    );
  });
