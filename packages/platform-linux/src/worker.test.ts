import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Fiber } from "effect";

import { manageWorker, type SystemctlRun, userConfigHome, workerPaths } from "#src/worker";

const ok = (stdout = ""): SystemctlRun => ({ code: 0, stdout, stderr: "" });

/** Tracks unit state the way a user manager would for the subcommands the worker issues. */
const fakeSystemd = () => {
  const calls: ReadonlyArray<string>[] = [];
  const state = { loaded: false, active: false };

  const systemctl = async (args: ReadonlyArray<string>) => {
    calls.push(args);

    switch (args[0]) {
      case "show":
        return ok(
          `LoadState=${state.loaded ? "loaded" : "not-found"}\nActiveState=${state.active ? "active" : "inactive"}\n`,
        );
      case "daemon-reload":
        state.loaded = true;
        break;
      case "enable":
      case "start":
      case "restart":
        state.active = true;
        break;
      case "stop":
      case "disable":
        state.active = false;
        break;
    }

    return ok();
  };

  return { calls, state, systemctl };
};

const noBus = async () => ({
  code: 1,
  stdout: "",
  stderr: "Failed to connect to bus: No medium found",
});

const launchIn = (home: string) => ({
  dataDirectory: join(home, "data"),
  executable: "/custom path/poppet",
  arguments: ["worker", "run"],
  workingDirectory: home,
  environment: new Map<string, string>(),
});

describe("manageWorker", () => {
  test("restart requires installation, restarts running or stopped units, and retains configuration on failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "poppet-systemd-restart-"));
    const launch = launchIn(home);
    const paths = workerPaths(launch, home);
    const { calls, state, systemctl } = fakeSystemd();

    try {
      await expect(
        Effect.runPromise(manageWorker("restart", launch, home, systemctl)),
      ).rejects.toMatchObject({ message: expect.stringContaining("Install the worker first") });
      expect(calls.map((args) => args[0])).toEqual(["show"]);
      await Effect.runPromise(manageWorker("install", launch, home, systemctl));
      const original = await readFile(paths.file, "utf8");

      await Array.fromAsync([true, false], async (running) => {
        state.active = running;
        state.loaded = running;
        calls.length = 0;
        expect(await Effect.runPromise(manageWorker("restart", launch, home, systemctl))).toContain(
          "Worker restarted",
        );
        expect(calls).toEqual([
          ["show", "--property=LoadState,ActiveState", paths.unit],
          ...(running ? [] : [["daemon-reload"]]),
          ["restart", paths.unit],
        ]);
        expect(state.active).toBe(true);
        expect(await readFile(paths.file, "utf8")).toBe(original);
      });

      await expect(
        Effect.runPromise(
          manageWorker("restart", launch, home, async (args) =>
            args[0] === "restart" ? { code: 1, stdout: "", stderr: "" } : systemctl(args),
          ),
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining("restart failed") });
      expect(await readFile(paths.file, "utf8")).toBe(original);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("when managing a login worker, escapes the launch description and protects installed files", async () => {
    const home = await mkdtemp(join(tmpdir(), "poppet-systemd-"));

    const launch = {
      dataDirectory: join(home, "data 100%"),
      executable: "/custom path/poppet",
      arguments: ["worker", "run", '$HOME "quoted" \\ 50%'],
      workingDirectory: join(home, "work 100%"),
      environment: new Map([["POPPET_APP_NAME", 'Poppet "$Acorn" 100%']]),
    };

    const configHome = join(home, ".config");
    const paths = workerPaths(launch, configHome);
    const { calls, state, systemctl } = fakeSystemd();

    try {
      await Effect.runPromise(manageWorker("install", launch, configHome, systemctl));
      const unit = await readFile(paths.file, "utf8");
      expect(paths.file).toBe(join(configHome, "systemd", "user", paths.unit));
      expect(unit).toContain(
        String.raw`ExecStart="/custom path/poppet" "worker" "run" "$$HOME \"quoted\" \\ 50%%"`,
      );
      expect(unit).toContain(`WorkingDirectory=${join(home, "work 100%%")}\n`);
      expect(unit).toContain(String.raw`Environment="POPPET_APP_NAME=Poppet \"$Acorn\" 100%%"`);
      expect(unit).toContain("KillMode=mixed\n");
      expect(unit).toContain("WantedBy=default.target\n");
      expect((await stat(paths.file)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.logs)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.log)).mode & 0o777).toBe(0o600);
      expect(calls.slice(1)).toEqual([["daemon-reload"], ["enable", "--now", paths.unit]]);
      await expect(
        Effect.runPromise(manageWorker("install", launch, configHome, systemctl)),
      ).rejects.toMatchObject({ message: expect.stringContaining("already installed") });
      await Effect.runPromise(manageWorker("stop", launch, configHome, systemctl));
      expect(
        await Effect.runPromise(manageWorker("status", launch, configHome, systemctl)),
      ).toEqual({ installed: true, active: false, file: paths.file, log: paths.log });
      expect(calls).toContainEqual(["stop", paths.unit]);
      await Effect.runPromise(manageWorker("start", launch, configHome, systemctl));
      await Effect.runPromise(manageWorker("start", launch, configHome, systemctl));
      expect(calls.filter((args) => args[0] === "start")).toHaveLength(2);
      expect(calls.filter((args) => args[0] === "daemon-reload")).toHaveLength(1);
      await writeFile(paths.log, "completed\nfailed reason=provider:quota\n");
      expect(
        await Effect.runPromise(manageWorker("logs", launch, configHome, systemctl)),
      ).toContain("failed reason=provider:quota");
      calls.length = 0;
      await Effect.runPromise(manageWorker("uninstall", launch, configHome, systemctl));
      expect(calls.slice(1)).toEqual([["disable", "--now", paths.unit], ["daemon-reload"]]);
      expect(state.active).toBe(false);
      expect(await Bun.file(paths.file).exists()).toBe(false);
      expect(await Bun.file(paths.log).exists()).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("when a unit file is not yet loaded, reloads before starting it", async () => {
    const home = await mkdtemp(join(tmpdir(), "poppet-systemd-reload-"));
    const launch = launchIn(home);
    const { calls, state, systemctl } = fakeSystemd();

    try {
      await Effect.runPromise(manageWorker("install", launch, home, systemctl));
      await Effect.runPromise(manageWorker("stop", launch, home, systemctl));
      state.loaded = false;
      calls.length = 0;
      await Effect.runPromise(manageWorker("start", launch, home, systemctl));
      expect(calls.slice(1)).toEqual([
        ["daemon-reload"],
        ["start", workerPaths(launch, home).unit],
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("when worker launch fails, reports it without discarding installed configuration", async () => {
    const home = await mkdtemp(join(tmpdir(), "poppet-systemd-error-"));
    const launch = launchIn(home);
    const { systemctl } = fakeSystemd();

    const failing = async (args: ReadonlyArray<string>) =>
      args[0] === "enable" ? { code: 1, stdout: "", stderr: "Job failed." } : await systemctl(args);

    try {
      await expect(
        Effect.runPromise(manageWorker("install", launch, home, failing)),
      ).rejects.toMatchObject({ message: expect.stringContaining("enable failed (exit 1)") });
      expect(await Bun.file(workerPaths(launch, home).file).exists()).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("when worker inspection fails, retains the installation and reports no successful removal", async () => {
    const home = await mkdtemp(join(tmpdir(), "poppet-systemd-inspection-"));
    const launch = launchIn(home);
    const paths = workerPaths(launch, home);
    const { systemctl } = fakeSystemd();

    try {
      await Effect.runPromise(manageWorker("install", launch, home, systemctl));
      const original = await readFile(paths.file, "utf8");
      const calls: ReadonlyArray<string>[] = [];

      const failed = async (args: ReadonlyArray<string>) => {
        calls.push(args);

        return { code: 1, stdout: "", stderr: "Access denied" };
      };

      await Promise.all(
        (["status", "restart", "stop", "uninstall"] as const).map(async (action) => {
          await expect(
            Effect.runPromise(manageWorker(action, launch, home, failed)),
          ).rejects.toMatchObject({ message: expect.stringContaining("show failed (exit 1)") });
          expect(await readFile(paths.file, "utf8")).toBe(original);
        }),
      );
      expect(calls.every((args) => args[0] === "show")).toBe(true);

      await expect(
        Effect.runPromise(manageWorker("status", launch, home, noBus)),
      ).rejects.toMatchObject({ message: expect.stringContaining("XDG_RUNTIME_DIR") });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("when a launch value contains a line break, refuses to write the unit", async () => {
    const home = await mkdtemp(join(tmpdir(), "poppet-systemd-control-"));
    const launch = { ...launchIn(home), arguments: ["worker", "run\nExecStartPre=/bin/false"] };
    const { calls, systemctl } = fakeSystemd();

    try {
      await expect(
        Effect.runPromise(manageWorker("install", launch, home, systemctl)),
      ).rejects.toMatchObject({ message: expect.stringContaining("control characters") });
      expect(await Bun.file(workerPaths(launch, home).file).exists()).toBe(false);
      expect(calls.map((args) => args[0])).toEqual(["show"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("when installation is interrupted, waits for mutations to finish", async () => {
    const home = await mkdtemp(join(tmpdir(), "poppet-systemd-interrupt-"));
    const launch = launchIn(home);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { calls, systemctl } = fakeSystemd();

    const blocking = async (args: ReadonlyArray<string>) => {
      if (args[0] === "show") {
        entered.resolve();
        await release.promise;
      }

      return await systemctl(args);
    };

    const owner = Effect.runFork(manageWorker("install", launch, home, blocking));
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
      expect(await Bun.file(workerPaths(launch, home).file).exists()).toBe(false);
      release.resolve();
      await stopped;
      expect(interrupted).toBe(true);
      expect(calls.map((args) => args[0])).toEqual(["show", "daemon-reload", "enable"]);
      expect(await Bun.file(workerPaths(launch, home).file).exists()).toBe(true);
    } finally {
      release.resolve();

      if (stopped !== null) await stopped;
      await Effect.runPromise(Fiber.interrupt(owner));
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("userConfigHome", () => {
  test("when XDG_CONFIG_HOME is relative or unset, uses ~/.config", () => {
    expect(userConfigHome("/home/a", "/srv/config")).toBe("/srv/config");
    expect(userConfigHome("/home/a", "config")).toBe("/home/a/.config");
    expect(userConfigHome("/home/a", undefined)).toBe("/home/a/.config");
  });
});
