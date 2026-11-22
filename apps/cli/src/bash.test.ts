import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Bash } from "@poppet/agent";
import { Effect, Fiber } from "effect";

import { BashLive, executeBash } from "#src/bash";

import { bashFixtures } from "../../../tools/testing/bash-fixtures";

const signal = () => new AbortController().signal;

const exited = async (pid: number, deadline = Date.now() + 2000): Promise<boolean> => {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }

  if (Date.now() >= deadline) return false;

  await Bun.sleep(10);

  return exited(pid, deadline);
};

describe("executeBash", () => {
  test("when a detached descendant holds output pipes, returns promptly on timeout", async () => {
    const started = performance.now();
    await expect(
      executeBash(
        {
          command: bashFixtures.detachedPipe,
          cwd: tmpdir(),
          timeoutSeconds: 0.3,
        },
        4096,
        signal(),
      ),
    ).rejects.toMatchObject({ reason: "tool-uncertain" });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("when the host environment includes secrets and Bash controls, passes only allowed values", async () => {
    const { POPPET_TEST_KEY, CDPATH } = process.env;
    process.env.POPPET_TEST_KEY = "test-secret";
    process.env.CDPATH = "/private";

    try {
      const result = await executeBash(
        { command: bashFixtures.environment, cwd: tmpdir(), timeoutSeconds: 5 },
        4096,
        signal(),
      );

      expect(result.stdout).toBe("||present");
    } finally {
      if (POPPET_TEST_KEY === undefined) delete process.env.POPPET_TEST_KEY;
      else process.env.POPPET_TEST_KEY = POPPET_TEST_KEY;

      if (CDPATH === undefined) delete process.env.CDPATH;
      else process.env.CDPATH = CDPATH;
    }
  });
});

describe("Bash execution", () => {
  test("runs shell operations in the exact directory and returns bounded stdout, stderr, and exit status", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "poppet-bash-"));

    try {
      const result = await executeBash(
        {
          command: bashFixtures.output,
          cwd,
          timeoutSeconds: 5,
        },
        4096,
        signal(),
      );

      expect(result).toEqual({ stdout: "hello", stderr: "problem", exitCode: 7, truncated: false });
      expect(await readFile(join(cwd, "result"), "utf8")).toBe("hello");

      const large = await executeBash(
        { command: bashFixtures.overflow, cwd, timeoutSeconds: 5 },
        1024,
        signal(),
      );

      expect(large.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThanOrEqual(1024);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("when output crosses the byte limit, retains only complete UTF-8 characters", async () => {
    const result = await executeBash(
      { command: bashFixtures.unicode, cwd: tmpdir(), timeoutSeconds: 5 },
      176,
      signal(),
    );

    expect(result).toEqual({ stdout: "a", stderr: "🌻", exitCode: 0, truncated: true });
  });

  test("times out and stops background children even when the shell has already exited", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "poppet-bash-stop-"));

    try {
      await expect(
        executeBash({ command: bashFixtures.timeout, cwd, timeoutSeconds: 0.1 }, 1024, signal()),
      ).rejects.toMatchObject({ reason: "tool-uncertain" });
      const started = Date.now();

      const result = await executeBash(
        { command: bashFixtures.background, cwd, timeoutSeconds: 5 },
        1024,
        signal(),
      );

      expect(result.exitCode).toBe(0);
      expect(await exited(Number(result.stdout.trim()))).toBe(true);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("cancellation waits for cleanup, and missing directories never start a shell", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "poppet-bash-cancel-"));

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const runner = yield* Bash;

          const fiber = yield* runner
            .run({ command: bashFixtures.cancellation, cwd, timeoutSeconds: 60 }, 1024)
            .pipe(Effect.forkChild);

          yield* Effect.gen(function* () {
            while (!(yield* Effect.promise(() => Bun.file(join(cwd, "pid")).exists())))
              yield* Effect.sleep("10 millis");
          }).pipe(Effect.timeout("2 seconds"));
          const pid = Number(yield* Effect.promise(() => readFile(join(cwd, "pid"), "utf8")));
          yield* Fiber.interrupt(fiber);
          expect(() => process.kill(pid, 0)).toThrow();
        }).pipe(Effect.provide(BashLive)),
      );
      await expect(
        executeBash(
          { command: bashFixtures.missingDirectory, cwd: join(cwd, "missing"), timeoutSeconds: 5 },
          1024,
          signal(),
        ),
      ).rejects.toMatchObject({ reason: "command-unavailable" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
