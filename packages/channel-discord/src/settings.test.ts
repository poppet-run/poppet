import { describe, expect, test } from "bun:test";
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Redacted } from "effect";

import { loadDiscordSettings, saveDiscordSettings } from "#src/settings";

const settings = {
  version: 1 as const,
  botId: "100",
  ownerId: "200",
  guildId: "300",
  channelIds: ["400"],
  token: Redacted.make("discord-secret"),
};

describe.concurrent("Discord settings", () => {
  test("loads protected settings without leaking the token in application values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-discord-"));

    try {
      expect(await Effect.runPromise(loadDiscordSettings(directory))).toBeNull();
      await Effect.runPromise(saveDiscordSettings(directory, settings));
      expect((await stat(join(directory, "channels"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, "channels/discord.json"))).mode & 0o777).toBe(0o600);
      const loaded = await Effect.runPromise(loadDiscordSettings(directory));
      expect(loaded?.channelIds).toEqual(["400"]);
      expect(loaded && Redacted.value(loaded.token)).toBe("discord-secret");
      expect(JSON.stringify(loaded)).not.toContain("discord-secret");
      await chmod(join(directory, "channels/discord.json"), 0o644);
      await Effect.runPromise(loadDiscordSettings(directory));
      expect((await stat(join(directory, "channels/discord.json"))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["symlink", "hardlink", "oversized", "invalid"])(
    "rejects %s settings without exposing their contents",
    async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-discord-invalid-"));

      try {
        await Effect.runPromise(saveDiscordSettings(directory, settings));
        const path = join(directory, "channels/discord.json");
        const other = join(directory, "other");
        await writeFile(other, await readFile(path));
        await rm(path);

        if (kind === "symlink") await symlink(other, path);
        else if (kind === "hardlink") await link(other, path);
        else
          await writeFile(
            path,
            kind === "oversized" ? "discord-secret".repeat(2000) : "discord-secret",
          );
        const result = await Effect.runPromise(loadDiscordSettings(directory).pipe(Effect.result));
        expect(result).toHaveProperty("failure.reason", "configuration");
        expect(JSON.stringify(result)).not.toContain("discord-secret");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
