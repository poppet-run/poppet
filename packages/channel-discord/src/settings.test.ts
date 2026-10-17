import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  test("round-trips settings without leaking the token in application values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-discord-"));

    try {
      expect(await Effect.runPromise(loadDiscordSettings(directory))).toBeNull();
      await Effect.runPromise(saveDiscordSettings(directory, settings));
      const loaded = await Effect.runPromise(loadDiscordSettings(directory));
      expect(loaded).toEqual(settings);
      expect(loaded && Redacted.value(loaded.token)).toBe("discord-secret");
      expect(JSON.stringify(loaded)).not.toContain("discord-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([
    { name: "malformed JSON", contents: "discord-secret" },
    {
      name: "empty allowed channels",
      contents: JSON.stringify({ ...settings, channelIds: [], token: "discord-secret" }),
    },
  ])("rejects $name without exposing settings contents", async ({ contents }) => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-discord-invalid-"));

    try {
      await Effect.runPromise(saveDiscordSettings(directory, settings));
      const path = join(directory, "channels/discord.json");
      await writeFile(path, contents);
      const result = await Effect.runPromise(loadDiscordSettings(directory).pipe(Effect.result));
      expect(result).toHaveProperty("failure.reason", "configuration");
      expect(JSON.stringify(result)).not.toContain("discord-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
