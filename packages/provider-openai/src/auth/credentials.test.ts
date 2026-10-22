import { describe, expect, test } from "bun:test";
import { link, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { acquireOwnerLock } from "@poppet/credentials/lock";
import { Effect } from "effect";

import { createHarness, login, status } from "#src/test/fixtures/chatgpt";

import { makeFIFO } from "../../../../tools/testing/fifo";

describe("Credential storage", () => {
  test("rejects malformed stored credentials and competing owners", async () => {
    const harness = await createHarness();

    try {
      await harness.run(status);
      const path = join(harness.directory, "auth/connection.json");
      await writeFile(path, "invalid-json");
      await expect(harness.run(status)).rejects.toMatchObject({ reason: "storage" });
      expect(await readFile(path, "utf8")).toBe("invalid-json");
      // A competing owner holds the exclusive lock while status runs.
      await Effect.runPromise(
        Effect.scoped(
          acquireOwnerLock(join(harness.directory, "auth/owner.lock")).pipe(
            Effect.andThen(
              Effect.promise(async () => {
                await expect(harness.run(status)).rejects.toMatchObject({ reason: "busy" });
              }),
            ),
          ),
        ),
      );
    } finally {
      await harness.close();
    }
  });
  test.each(["symlink", "hardlink", "fifo"])(
    "rejects credential %s files without reading or changing their targets",
    async (kind) => {
      const harness = await createHarness();

      try {
        await harness.run(login);
        const path = join(harness.directory, "auth/connection.json");
        const target = join(harness.directory, "unrelated-file");
        await writeFile(target, "keep this file", { mode: 0o644 });
        await unlink(path);

        if (kind === "symlink") await symlink(target, path);
        else if (kind === "hardlink") await link(target, path);
        else makeFIFO(path);

        await expect(harness.run(status)).rejects.toMatchObject({ reason: "storage" });
        expect(await readFile(target, "utf8")).toBe("keep this file");
        expect((await stat(target)).mode & 0o777).toBe(0o644);

        if (kind === "symlink") {
          await unlink(target);
          await expect(harness.run(status)).rejects.toMatchObject({ reason: "storage" });
        }
      } finally {
        await harness.close();
      }
    },
  );
});
