import { describe, expect, test } from "bun:test";
import { chmod, link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readContextFile } from "#src/context-file";

describe("readContextFile", () => {
  test("when a context file is group-writable or hardlinked, rejects it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-context-file-"));
    const file = join(directory, "soul.md");

    try {
      await writeFile(file, "Hello", { mode: 0o600 });
      expect(await readContextFile(file, 1024)).toBe("Hello");

      await chmod(file, 0o664);
      await expect(readContextFile(file, 1024)).rejects.toThrow("private regular file");

      await chmod(file, 0o600);
      await link(file, join(directory, "hardlink.md"));
      await expect(readContextFile(file, 1024)).rejects.toThrow("private regular file");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
