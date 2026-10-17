import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { remoteTaskCommand } from "@poppet/tasks";
import { workerSocketPath } from "@poppet/worker";
import { Effect } from "effect";

import { workerLaunch } from "#src/worker";
import { runLoggedWorker } from "#src/worker-background";
import { workerLogBytes } from "#src/worker-log";

test("captures both streams through rotation, drains final output, and returns the child's failure", async () => {
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

test("the installed launcher forwards shutdown, drains logs, and releases worker ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-background-shutdown-"));

  await writeFile(join(directory, "config.json"), JSON.stringify({ provider: "opencode-go" }));

  const launch = workerLaunch({
    applicationName: "Test",
    dataDirectory: directory,
    notesDirectory: join(directory, "notes"),
    provider: "openrouter",
    model: null,
  });

  const child = Bun.spawn([launch.executable, ...launch.arguments], {
    cwd: launch.workingDirectory,
    env: { PATH: process.env.PATH ?? "", ...Object.fromEntries(launch.environment) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const path = join(directory, "logs/worker.log");

  try {
    // The ready line follows socket permissions and scoped service acquisition.
    let ready = false;

    // The subprocess must publish readiness before this test sends commands or signals.
    /* eslint-disable no-await-in-loop */
    for (let attempt = 0; attempt < 500; attempt++) {
      if (
        (await Bun.file(path).exists()) &&
        (await readFile(path, "utf8")).includes("Worker running.")
      ) {
        ready = true;
        break;
      }

      if (child.exitCode !== null) break;
      await Bun.sleep(10);
    }
    /* eslint-enable no-await-in-loop */

    expect(ready).toBe(true);

    const reply = await Effect.runPromise(
      remoteTaskCommand(workerSocketPath(directory), { action: "status" }),
    );

    expect(reply?.value).toMatchObject({
      running: true,
      connections: [expect.objectContaining({ provider: "opencode-go" })],
    });
    // A second launcher must fail before it can start another child or rotate these logs.
    const before = await readFile(path, "utf8");
    await expect(
      runLoggedWorker([process.execPath, "--eval", 'console.log("unwanted child")'], directory),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(before);
    child.kill("SIGTERM");
    await child.exited;
    expect(await stdout).toBe("");
    expect(await stderr).toBe("");
    expect(await Bun.file(join(directory, "logs/worker.lock")).exists()).toBe(false);
    expect(
      await Effect.runPromise(remoteTaskCommand(workerSocketPath(directory), { action: "status" })),
    ).toBeNull();
    expect(await readFile(path, "utf8")).toContain("Worker running.");
    // Restart can acquire both logging and store ownership without replaying anything.
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
}, 15_000);
