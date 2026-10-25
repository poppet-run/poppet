import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Fiber } from "effect";
import { describe, expect, test } from "vitest";

import { manageWorker, workerPaths } from "#src/worker";

describe("manageWorker", () => {
  test("when managing a login worker, uses the supplied launch description and protects installed files", async () => {
    const home = await mkdtemp(join(tmpdir(), "poppet-launchd-"));

    const launch = {
      dataDirectory: join(home, "data & notes"),
      executable: "/custom path/poppet",
      arguments: ["worker", "run"],
      workingDirectory: home,
      environment: new Map([["POPPET_APP_NAME", "Poppet & Acorn"]]),
    };

    const paths = workerPaths(launch, home);
    const calls: ReadonlyArray<string>[] = [];
    let loaded = false;

    const launchctl = async (args: ReadonlyArray<string>) => {
      calls.push(args);

      if (args[0] === "print") return loaded ? 0 : 113;

      if (args[0] === "bootstrap" || args[0] === "kickstart") loaded = true;

      if (args[0] === "bootout") loaded = false;

      return 0;
    };

    try {
      await Effect.runPromise(manageWorker("install", launch, home, launchctl));
      const plist = await readFile(paths.plist, "utf8");
      expect(plist).toContain("Poppet &amp; Acorn");
      expect(plist).toContain("<key>KeepAlive</key><true/>");
      expect(plist).toContain("<string>worker</string><string>run</string>");
      expect(plist).toContain("<string>/custom path/poppet</string>");
      expect((await stat(paths.plist)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.logs)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.log)).mode & 0o777).toBe(0o600);
      await expect(
        Effect.runPromise(manageWorker("install", launch, home, launchctl)),
      ).rejects.toMatchObject({ message: expect.stringContaining("already installed") });
      await Effect.runPromise(manageWorker("stop", launch, home, launchctl));
      expect(
        await Effect.runPromise(manageWorker("status", launch, home, launchctl)),
      ).toMatchObject({
        installed: true,
        loaded: false,
      });
      await Effect.runPromise(manageWorker("start", launch, home, launchctl));
      await Effect.runPromise(manageWorker("start", launch, home, launchctl));
      expect(calls).toContainEqual(["kickstart", `gui/${process.getuid?.()}/${paths.label}`]);
      expect(calls.flat()).not.toContain("-k");
      await writeFile(paths.log, "completed\nfailed reason=provider:quota\n");
      expect(await Effect.runPromise(manageWorker("logs", launch, home, launchctl))).toContain(
        "failed reason=provider:quota",
      );
      await Effect.runPromise(manageWorker("uninstall", launch, home, launchctl));
      expect(await Bun.file(paths.plist).exists()).toBe(false);
      expect(await Bun.file(paths.log).exists()).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("when worker launch fails, reports it without discarding installed configuration", async () => {
    const home = await mkdtemp(join(tmpdir(), "poppet-launchd-error-"));

    const launch = {
      dataDirectory: join(home, "data"),
      executable: "/custom path/poppet",
      arguments: ["worker", "run"],
      workingDirectory: home,
      environment: new Map<string, string>(),
    };

    try {
      await expect(
        Effect.runPromise(manageWorker("install", launch, home, async () => 113)),
      ).rejects.toMatchObject({ message: expect.stringContaining("bootstrap failed") });
      expect(await Bun.file(workerPaths(launch, home).plist).exists()).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("when recent logs span rotated files, reads them within one 64 KiB budget", async () => {
    const home = await mkdtemp(join(tmpdir(), "poppet-launchd-logs-"));

    const launch = {
      dataDirectory: home,
      executable: "/custom path/poppet",
      arguments: [],
      workingDirectory: home,
      environment: new Map<string, string>(),
    };

    const paths = workerPaths(launch, home);

    try {
      await mkdir(paths.logs, { mode: 0o700 });
      await writeFile(
        `${paths.log}.1`,
        "old partial line" + "x".repeat(65_536) + "\narchived line\n",
      );
      await writeFile(paths.log, "current line\n");
      expect(await Effect.runPromise(manageWorker("logs", launch, home))).toBe(
        "archived line\ncurrent line",
      );
      await writeFile(paths.log, "");
      expect(await Effect.runPromise(manageWorker("logs", launch, home))).toBe("archived line");
      await writeFile(`${paths.log}.1`, "prefix of ");
      await writeFile(paths.log, "one line\n");
      expect(await Effect.runPromise(manageWorker("logs", launch, home))).toBe(
        "prefix of one line",
      );
      await symlink(paths.log, `${paths.log}.2`);
      await expect(Effect.runPromise(manageWorker("logs", launch, home))).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("when worker inspection fails, retains the installation and reports no successful removal", async () => {
    const home = await mkdtemp(join(tmpdir(), "poppet-launchd-inspection-"));

    const launch = {
      dataDirectory: join(home, "data"),
      executable: "/custom path/poppet",
      arguments: ["worker", "run"],
      workingDirectory: home,
      environment: new Map<string, string>(),
    };

    const paths = workerPaths(launch, home);
    let loaded = false;

    const successful = async (args: ReadonlyArray<string>) => {
      if (args[0] === "print") return loaded ? 0 : 113;

      if (args[0] === "bootstrap") loaded = true;

      return 0;
    };

    try {
      await Effect.runPromise(manageWorker("install", launch, home, successful));
      const original = await readFile(paths.plist, "utf8");
      const calls: ReadonlyArray<string>[] = [];

      const failed = async (args: ReadonlyArray<string>) => {
        calls.push(args);

        return 1;
      };

      await Promise.all(
        (["status", "stop", "uninstall"] as const).map(async (action) => {
          await expect(
            Effect.runPromise(manageWorker(action, launch, home, failed)),
          ).rejects.toMatchObject({ message: expect.stringContaining("print failed (exit 1)") });
          expect(await readFile(paths.plist, "utf8")).toBe(original);
        }),
      );

      expect(calls.every((args) => args[0] === "print")).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("when installation is interrupted, waits for mutations to finish", async () => {
    const home = await mkdtemp(join(tmpdir(), "poppet-launchd-interrupt-"));

    const launch = {
      dataDirectory: join(home, "data"),
      executable: "/custom path/poppet",
      arguments: ["worker", "run"],
      workingDirectory: home,
      environment: new Map<string, string>(),
    };

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const calls: ReadonlyArray<string>[] = [];

    const launchctl = async (args: ReadonlyArray<string>) => {
      calls.push(args);

      if (args[0] === "print") {
        entered.resolve();
        await release.promise;

        return 113;
      }

      return 0;
    };

    const owner = Effect.runFork(manageWorker("install", launch, home, launchctl));
    let interrupted = false;
    let stopped: Promise<boolean> | null = null;

    try {
      await entered.promise;
      stopped = Effect.runPromise(Fiber.interrupt(owner)).then(() => {
        interrupted = true;

        return true;
      });
      await Bun.sleep(10);
      expect(interrupted).toBe(false);
      expect(await Bun.file(workerPaths(launch, home).plist).exists()).toBe(false);
      release.resolve();
      await stopped;
      expect(interrupted).toBe(true);
      expect(calls.map((args) => args[0])).toEqual(["print", "bootstrap"]);
      expect(await Bun.file(workerPaths(launch, home).plist).exists()).toBe(true);
    } finally {
      release.resolve();

      if (stopped !== null) await stopped;
      await Effect.runPromise(Fiber.interrupt(owner));
      await rm(home, { recursive: true, force: true });
    }
  });
});
