import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

import { workerLogBytes } from "#src/commands/worker/log";
import { runLoggedWorker } from "#src/worker-background";

describe("runLoggedWorker", () => {
  test("when the child exits with a failure, drains both streams through rotation and returns its exit code", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-logged-child-"));

    try {
      const exitCode = await runLoggedWorker(
        [
          process.execPath,
          "--eval",
          `
        await Bun.write(Bun.stdout, "a".repeat(${workerLogBytes}));
        await Bun.write(Bun.stdout, "stdout finished\\n");
        await Bun.write(Bun.stderr, "stderr finished\\n");
        process.exitCode = 7;
      `,
        ],
        directory,
      );

      const content = Buffer.concat(
        await Promise.all([
          readFile(join(directory, "logs/worker.log.1")),
          readFile(join(directory, "logs/worker.log")),
        ]),
      ).toString();

      expect(exitCode).toBe(7);
      expect(content.split("a").length - 1).toBe(workerLogBytes);
      expect(content).toContain("stdout finished\n");
      expect(content).toContain("stderr finished\n");
      expect(await Bun.file(join(directory, "logs/worker.lock")).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when the launcher receives shutdown, forwards it, drains logs, and releases ownership", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-background-shutdown-"));

    const worker = `
      const timer = setInterval(() => undefined, 1000);
      console.log("Worker running.");
      process.on("SIGTERM", () => {
        console.log("Worker stopped.");
        clearInterval(timer);
      });
    `;

    const launcher = `
      import { runLoggedWorker } from ${JSON.stringify(fileURLToPath(new URL("../../worker-background.ts", import.meta.url)))};
      process.exitCode = await runLoggedWorker(
        [process.execPath, "--eval", ${JSON.stringify(worker)}],
        ${JSON.stringify(directory)},
      );
    `;

    const child = Bun.spawn([process.execPath, "--eval", launcher], {
      env: { PATH: process.env.PATH ?? "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const path = join(directory, "logs/worker.log");

    try {
      const ready = await Effect.runPromise(
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 500; attempt++) {
            const content = yield* Effect.promise(async () =>
              (await Bun.file(path).exists()) ? readFile(path, "utf8") : "",
            );

            if (content.includes("Worker running.")) return true;

            if (child.exitCode !== null) return false;
            yield* Effect.sleep("10 millis");
          }

          return false;
        }),
      );

      expect(ready).toBe(true);
      const before = await readFile(path, "utf8");
      await expect(
        runLoggedWorker([process.execPath, "--eval", 'console.log("unwanted child")'], directory),
      ).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(before);
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      expect(await stdout).toBe("");
      expect(await stderr).toBe("");
      expect(await Bun.file(join(directory, "logs/worker.lock")).exists()).toBe(false);
      expect(await readFile(path, "utf8")).toBe("Worker running.\nWorker stopped.\n");
      expect(
        await runLoggedWorker([process.execPath, "--eval", 'console.log("restarted")'], directory),
      ).toBe(0);
      expect(await readFile(path, "utf8")).toContain("restarted\n");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      await Promise.all([stdout, stderr]);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when log rotation fails while the child writes heavily on shutdown, drains pipes without deadlocking", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-background-log-error-"));

    try {
      const worker = `
        import { symlinkSync } from "node:fs";
        import { join } from "node:path";
        const dir = ${JSON.stringify(join(directory, "logs"))};
        process.on("SIGTERM", () => {
          process.stdout.write("z".repeat(256 * 1024));
          process.stderr.write("y".repeat(256 * 1024));
          process.exit(0);
        });
        await Bun.write(Bun.stdout, "a".repeat(${workerLogBytes}));
        symlinkSync(join(dir, "worker.log"), join(dir, "worker.log.2"));
        await Bun.write(Bun.stdout, "trigger rotation\\n");
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      `;

      const startedAt = Date.now();
      await expect(
        runLoggedWorker([process.execPath, "--eval", worker], directory),
      ).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(await Bun.file(join(directory, "logs/worker.lock")).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
