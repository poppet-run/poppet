import { describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openWorkerLog, workerLogBytes } from "#src/worker-log";

describe("openWorkerLog", () => {
  test("when logs fill and the writer restarts, retains three archives and resumes appending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-log-retention-"));
    const path = join(directory, "worker.log");
    let log = openWorkerLog(directory);

    try {
      for (let index = 0; index < 5; index++) log.write(Buffer.alloc(workerLogBytes, 65 + index));
      log.close();
      expect((await readdir(directory)).toSorted()).toEqual([
        "worker.log",
        "worker.log.1",
        "worker.log.2",
        "worker.log.3",
      ]);

      await Promise.all(
        ["", ".1", ".2", ".3"].map(async (suffix, index) => {
          const content = await readFile(path + suffix);
          expect(content.equals(Buffer.alloc(workerLogBytes, 69 - index))).toBe(true);
          expect((await stat(path + suffix)).mode & 0o777).toBe(0o600);
        }),
      );

      log = openWorkerLog(directory);
      log.write(Buffer.from("after restart\n"));
      log.close();
      expect(await readFile(path, "utf8")).toBe("after restart\n");
      expect((await readFile(`${path}.1`)).equals(Buffer.alloc(workerLogBytes, 69))).toBe(true);
      log = openWorkerLog(directory);
      log.write(Buffer.from("another line\n"));
      expect(await readFile(path, "utf8")).toBe("after restart\nanother line\n");
    } finally {
      log.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when a chunk exceeds the log limit, splits it without losing bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-log-chunks-"));
    const path = join(directory, "worker.log");
    const log = openWorkerLog(directory);

    try {
      const chunk = Buffer.alloc(workerLogBytes + 19, 66);
      log.write(chunk);

      const [recent, current] = await Promise.all([readFile(`${path}.1`), readFile(path)]);

      expect(Buffer.concat([recent, current]).equals(chunk)).toBe(true);
      expect(recent.length).toBe(workerLogBytes);
      expect(current.length).toBe(19);
    } finally {
      log.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["symlink", "hardlink", "directory", "public-directory"] as const)(
    "when a log path contains a %s, rejects it without changing its target",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "poppet-log-path-"));
      const directory = join(root, "logs");
      const target = join(root, "target");
      await writeFile(target, "retain this", { mode: 0o644 });
      await mkdir(directory, { mode: 0o700 });
      const archive = join(directory, "worker.log.1");

      try {
        if (kind === "symlink") await symlink(target, archive);
        else if (kind === "hardlink") await link(target, archive);
        else if (kind === "directory") await mkdir(archive);
        else await chmod(directory, 0o755);

        expect(() => openWorkerLog(directory)).toThrow();
        expect(await readFile(target, "utf8")).toBe("retain this");
        expect((await stat(target)).mode & 0o777).toBe(0o644);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("when an unsafe archive appears before rotation, rejects it and retains the active log", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-log-unsafe-"));
    const log = openWorkerLog(directory);

    try {
      log.write(Buffer.alloc(workerLogBytes, 65));
      await symlink(join(directory, "worker.log"), join(directory, "worker.log.2"));
      expect(() => log.write(Buffer.from("next"))).toThrow();
      expect((await stat(join(directory, "worker.log"))).size).toBe(workerLogBytes);
    } finally {
      log.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
