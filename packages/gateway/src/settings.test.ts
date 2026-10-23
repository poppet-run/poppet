import { describe, expect, test } from "bun:test";
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { loadChannelSettings, saveChannelSettings } from "#src/settings";

import { makeFIFO } from "../../../tools/testing/fifo";

describe.concurrent("settings.ts", () => {
  test("when channel settings are saved or read, protects files and repairs permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-channel-settings-"));
    const path = join(directory, "channels/test-channel.json");

    try {
      expect(await Effect.runPromise(loadChannelSettings(directory, "test-channel"))).toBeNull();
      await Effect.runPromise(saveChannelSettings(directory, "test-channel", "channel-secret"));
      expect((await stat(join(directory, "channels"))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await chmod(path, 0o644);
      expect(await Effect.runPromise(loadChannelSettings(directory, "test-channel"))).toBe(
        "channel-secret",
      );
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["symlink", "hardlink", "oversized", "fifo"])(
    "when channel settings are %s, rejects them without exposing content or changing link targets",
    async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-channel-invalid-"));

      try {
        await Effect.runPromise(saveChannelSettings(directory, "test-channel", "channel-secret"));
        const path = join(directory, "channels/test-channel.json");
        const other = join(directory, "other");
        await writeFile(other, "channel-secret", { mode: 0o644 });
        await rm(path);

        if (kind === "symlink") await symlink(other, path);
        else if (kind === "hardlink") await link(other, path);
        else if (kind === "fifo") makeFIFO(path);
        else await writeFile(path, "channel-secret".repeat(2000));

        const result = await Effect.runPromise(
          loadChannelSettings(directory, "test-channel").pipe(Effect.result),
        );

        expect(result).toHaveProperty("failure.reason", "configuration");
        expect(JSON.stringify(result)).not.toContain("channel-secret");
        expect(await readFile(other, "utf8")).toBe("channel-secret");
        expect((await stat(other)).mode & 0o777).toBe(0o644);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
