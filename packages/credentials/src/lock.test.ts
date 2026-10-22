import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { acquireOwnerLock } from "#src/lock";

import { makeFIFO } from "../../../tools/testing/fifo";

test("recovers a crashed owner and still excludes another process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-owner-"));
  const path = join(directory, "owner.lock");

  const script = `import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
    import { acquireOwnerLock } from ${JSON.stringify(import.meta.resolve("#src/lock"))};
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* acquireOwnerLock(${JSON.stringify(path)});
      console.log("owned");
      yield* Effect.never;
    })));`;

  const owner = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
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
    // A persistent lock database is safe to reuse; deleting it would bypass a live owner's lock.
    await Effect.runPromise(Effect.scoped(acquireOwnerLock(path)));
  } finally {
    owner.kill("SIGKILL");
    await owner.exited;
    expect(await errors).toBe("");
    await rm(directory, { recursive: true, force: true });
  }
});

test("replaces stale markers, even with a reused live PID, and rejects symlinks and named pipes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poppet-owner-protected-"));
  const path = join(directory, "owner.lock");
  const target = join(directory, "untouched");

  try {
    // After a crash and reboot, the saved PID can belong to an unrelated live process.
    await Effect.runPromise(
      Effect.forEach([JSON.stringify({ pid: process.pid }), "unknown old owner"], (marker) =>
        Effect.promise(() => writeFile(path, marker)).pipe(
          Effect.andThen(
            Effect.scoped(
              acquireOwnerLock(path).pipe(
                Effect.andThen(
                  Effect.promise(async () => {
                    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ pid: process.pid });
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
    makeFIFO(path);
    await expect(Effect.runPromise(Effect.scoped(acquireOwnerLock(path)))).rejects.toMatchObject({
      reason: "storage",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
