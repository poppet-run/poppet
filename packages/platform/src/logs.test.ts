import { describe, expect, test } from "bun:test";
import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareWorkerLog, readWorkerLogs } from "#src/logs";

describe("readWorkerLogs", () => {
  test("when recent logs span rotated files, reads them within one 64 KiB budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-worker-logs-"));
    const log = join(directory, "worker.log");

    try {
      await writeFile(`${log}.1`, "old partial line" + "x".repeat(65_536) + "\narchived line\n");
      await writeFile(log, "current line\n");
      expect(await readWorkerLogs(log)).toBe("archived line\ncurrent line");
      await writeFile(log, "");
      expect(await readWorkerLogs(log)).toBe("archived line");
      await writeFile(`${log}.1`, "prefix of ");
      await writeFile(log, "one line\n");
      expect(await readWorkerLogs(log)).toBe("prefix of one line");
      await symlink(log, `${log}.2`);
      await expect(readWorkerLogs(log)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when the budget is used up before an empty rotated file, still detects older logs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-worker-logs-"));
    const log = join(directory, "worker.log");
    const recent = "y".repeat(65_536 - "first\n".length - 1);

    try {
      await writeFile(log, `first\n${recent}\n`);
      await writeFile(`${log}.1`, "");
      await writeFile(`${log}.2`, "older\n");
      expect(await readWorkerLogs(log)).toBe(recent);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when preparing a worker log that is hardlinked, rejects it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-worker-log-prepare-"));
    const logs = join(directory, "logs");
    const target = join(directory, "other.txt");
    const log = join(logs, "worker.log");

    try {
      await prepareWorkerLog(logs, log);
      await writeFile(target, "other");
      await rm(log);
      await link(target, log);
      await expect(prepareWorkerLog(logs, log)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
