import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Bash } from "@poppet/agent";
import { Effect, Fiber } from "effect";

import { BashLive, executeBash } from "#src/bash";

import { bashFixtures } from "../../../tools/testing/bash-fixtures";

const signal = () => new AbortController().signal;

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

  test("times out and stops background children even when the shell has already exited", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "poppet-bash-stop-"));

    try {
      await expect(
        executeBash({ command: bashFixtures.timeout, cwd, timeoutSeconds: 1 }, 1024, signal()),
      ).rejects.toMatchObject({ reason: "tool-uncertain" });
      const started = Date.now();

      const result = await executeBash(
        { command: bashFixtures.background, cwd, timeoutSeconds: 5 },
        1024,
        signal(),
      );

      expect(result.exitCode).toBe(0);
      expect(() => process.kill(Number(result.stdout.trim()), 0)).toThrow();
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
