import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readWorkerLogs } from "#src/logs";

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
});
