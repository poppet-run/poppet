import { describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { makeRecordStore } from "#src/records";

const Counter = Schema.Struct({ count: Schema.Number });

describe("makeRecordStore", () => {
  test("when updates overlap, applies each change to the previous result and keeps files private", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-records-"));
    const records = makeRecordStore(directory);

    try {
      // Each change yields while holding the lock, so an unlocked store would lose increments.
      const increment = records.update("mcp-oauth-remote", (current) =>
        Effect.sleep("5 millis").pipe(
          Effect.as({
            count: (current === null ? 0 : Schema.decodeUnknownSync(Counter)(current).count) + 1,
          }),
        ),
      );

      await Effect.runPromise(Effect.all([increment, increment, increment], { concurrency: 3 }));
      expect(await Effect.runPromise(records.read("mcp-oauth-remote"))).toEqual({ count: 3 });
      expect((await stat(join(directory, "auth/mcp-oauth-remote.json"))).mode & 0o777).toBe(0o600);

      await Effect.runPromise(records.update("mcp-oauth-remote", () => Effect.succeed(null)));
      expect(await Effect.runPromise(records.read("mcp-oauth-remote"))).toBeNull();
      expect(await readdir(join(directory, "auth"))).not.toContain("mcp-oauth-remote.json");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when a record is copied under another name, rejects it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-records-"));
    const records = makeRecordStore(directory);

    try {
      await Effect.runPromise(records.update("first", () => Effect.succeed({ secret: "value" })));
      await copyFile(join(directory, "auth/first.json"), join(directory, "auth/second.json"));
      await expect(Effect.runPromise(records.read("second"))).rejects.toThrow(
        "protected second record",
      );
      await expect(Effect.runPromise(records.read("../first"))).rejects.toThrow(
        "protected ../first record",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
