import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { promoteSkill } from "#src/promotion";

describe("promoteSkill", () => {
  test("when promotion paths traverse or the library is symlinked, rejects them before writing files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-promotion-"));
    const data = join(directory, "data");
    const outside = join(directory, "outside");

    try {
      await mkdir(data);

      const invalid = await Effect.runPromise(
        promoteSkill(data, "../outside", "Private procedure").pipe(Effect.flip),
      );

      expect(invalid.reason).toBe("invalid-request");
      expect(await readdir(data)).toEqual([]);
      expect(await readdir(directory)).toEqual(["data"]);
      await mkdir(outside);
      await symlink(outside, join(data, "skills"));

      const linked = await Effect.runPromise(
        promoteSkill(data, "review", "Private procedure").pipe(Effect.flip),
      );

      expect(linked.reason).toBe("storage");
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
