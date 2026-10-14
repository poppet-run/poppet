import { describe, expect, test } from "bun:test";
import { readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createHarness, login, status } from "#src/test/fixtures/chatgpt";

describe("Credential storage", () => {
  test("rejects malformed stored credentials and competing owners", async () => {
    const harness = await createHarness();

    try {
      await harness.run(status);
      const path = join(harness.directory, "auth/connection.json");
      await writeFile(path, "invalid-json");
      await expect(harness.run(status)).rejects.toMatchObject({ reason: "storage" });
      expect(await readFile(path, "utf8")).toBe("invalid-json");
      await writeFile(join(harness.directory, "auth/owner.lock"), "another owner");
      await expect(harness.run(status)).rejects.toMatchObject({ reason: "busy" });
    } finally {
      await harness.close();
    }
  });
  test("rejects credential symlinks without reading or changing their targets", async () => {
    const harness = await createHarness();

    try {
      await harness.run(login);
      const path = join(harness.directory, "auth/connection.json");
      const target = join(harness.directory, "unrelated-file");
      await writeFile(target, "keep this file");
      await unlink(path);
      await symlink(target, path);
      await expect(harness.run(status)).rejects.toMatchObject({ reason: "storage" });
      expect(await readFile(target, "utf8")).toBe("keep this file");
      await unlink(target);
      await expect(harness.run(status)).rejects.toMatchObject({ reason: "storage" });
    } finally {
      await harness.close();
    }
  });
});
