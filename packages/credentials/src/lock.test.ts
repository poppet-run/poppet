import { describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { Effect } from "effect";

import { acquireOwnerLock } from "#src/lock";

import { makeFIFO } from "../../../tools/testing/fifo";

const probeLockInChildProcess = async (path: string) => {
  const script = `import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
  import { acquireOwnerLock } from ${JSON.stringify(import.meta.resolve("#src/lock"))};
  try {
    await Effect.runPromise(Effect.scoped(acquireOwnerLock(${JSON.stringify(path)})));
    console.log("acquired");
  } catch (error) {
    console.log(typeof error === "object" && error !== null && "reason" in error ? String(error.reason) : "error");
  }`;

  const child = Bun.spawn([process.execPath, "--eval", script], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(stderr).toBe("");
  expect(exitCode).toBe(0);

  return stdout.trim();
};

describe("acquireOwnerLock", () => {
  test("when the owner crashes, recovers the lock while still excluding another process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-owner-"));
    const path = join(directory, "owner.lock");

    const script = `import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
    import { acquireOwnerLock } from ${JSON.stringify(import.meta.resolve("#src/lock"))};
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* acquireOwnerLock(${JSON.stringify(path)});
      console.log("owned");
      yield* Effect.never;
    })));`;

    const owner = Bun.spawn([process.execPath, "--eval", script], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const errors = new Response(owner.stderr).text();

    try {
      const ready = await owner.stdout.getReader().read();
      expect(new TextDecoder().decode(ready.value)).toContain("owned");
      await expect(Effect.runPromise(Effect.scoped(acquireOwnerLock(path)))).rejects.toMatchObject({
        reason: "busy",
      });
      expect((await stat(`${path}.sqlite`)).mode & 0o777).toBe(0o600);
      owner.kill("SIGKILL");
      await owner.exited;
      expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(owner.pid);
      await Effect.runPromise(Effect.scoped(acquireOwnerLock(path)));
      expect(await Bun.file(path).exists()).toBe(false);
      await Effect.runPromise(Effect.scoped(acquireOwnerLock(path)));
    } finally {
      owner.kill("SIGKILL");
      await owner.exited;
      expect(await errors).toBe("");
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when lock markers are stale or unsafe, replaces stale markers and rejects symlinks, hard links, and named pipes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-owner-protected-"));
    const path = join(directory, "owner.lock");
    const target = join(directory, "untouched");

    try {
      await Effect.runPromise(
        Effect.forEach([JSON.stringify({ pid: process.pid }), "unknown old owner"], (marker) =>
          Effect.promise(() => writeFile(path, marker)).pipe(
            Effect.andThen(
              Effect.scoped(
                acquireOwnerLock(path).pipe(
                  Effect.andThen(
                    Effect.promise(async () => {
                      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
                        pid: process.pid,
                      });
                    }),
                  ),
                ),
              ),
            ),
            Effect.andThen(
              Effect.promise(async () => {
                expect(await Bun.file(path).exists()).toBe(false);
              }),
            ),
          ),
        ),
      );

      await writeFile(target, "keep this file");
      await symlink(target, path);
      await expect(Effect.runPromise(Effect.scoped(acquireOwnerLock(path)))).rejects.toMatchObject({
        reason: "storage",
      });
      expect(await readFile(target, "utf8")).toBe("keep this file");
      await rm(path);
      await link(target, path);
      await expect(Effect.runPromise(Effect.scoped(acquireOwnerLock(path)))).rejects.toMatchObject({
        reason: "storage",
      });
      expect(await readFile(path, "utf8")).toBe("keep this file");
      await rm(path);
      makeFIFO(path);
      await expect(Effect.runPromise(Effect.scoped(acquireOwnerLock(path)))).rejects.toMatchObject({
        reason: "storage",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when another fiber contends for a held lock, keeps the OS lock active against another process and allows re-acquisition after release", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-owner-contention-"));
    const path = join(directory, "owner.lock");
    const equivalentPath = join(directory, "..", basename(directory), "owner.lock");
    const symlinkDirectory = join(directory, "alias");

    try {
      await symlink(directory, symlinkDirectory);
      const symlinkedParentPath = join(symlinkDirectory, "owner.lock");

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* acquireOwnerLock(path);

            yield* Effect.promise(async () => {
              await expect(
                Effect.runPromise(Effect.scoped(acquireOwnerLock(path))),
              ).rejects.toMatchObject({ reason: "busy" });
              await expect(
                Effect.runPromise(Effect.scoped(acquireOwnerLock(equivalentPath))),
              ).rejects.toMatchObject({ reason: "busy" });
              await expect(
                Effect.runPromise(Effect.scoped(acquireOwnerLock(symlinkedParentPath))),
              ).rejects.toMatchObject({ reason: "busy" });

              expect(await probeLockInChildProcess(path)).toBe("busy");
            });
          }),
        ),
      );

      await Effect.runPromise(Effect.scoped(acquireOwnerLock(path)));
      expect(await probeLockInChildProcess(path)).toBe("acquired");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when marker cleanup fails, releases database ownership without failing the scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-owner-cleanup-"));
    const path = join(directory, "owner.lock");

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* acquireOwnerLock(path);
            yield* Effect.promise(async () => {
              await rm(path);
              await mkdir(path);
            });
          }),
        ),
      );
      await rm(path, { recursive: true });
      expect(await probeLockInChildProcess(path)).toBe("acquired");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when the owner marker is removed before release, releases cleanly and allows re-acquisition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-owner-missing-marker-"));
    const path = join(directory, "owner.lock");

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* acquireOwnerLock(path);
            yield* Effect.promise(() => rm(path));
          }),
        ),
      );

      await Effect.runPromise(Effect.scoped(acquireOwnerLock(path)));
      expect(await probeLockInChildProcess(path)).toBe("acquired");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
