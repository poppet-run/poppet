import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChannelEnvironment, ChannelInput } from "@poppet/gateway";
import { Effect, Redacted } from "effect";

import { discord } from "#src/registration";
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
  test("setup saves protected settings offline without leaking the token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-discord-"));

    try {
      expect(await Effect.runPromise(loadDiscordSettings(directory))).toBeNull();

      const message = await Effect.runPromise(
        discord
          .setup(["setup", "100", "200", "300", "400", "--key-stdin"])
          .pipe(
            Effect.provideService(ChannelEnvironment, { dataDirectory: directory }),
            Effect.provideService(ChannelInput, { readSecret: Effect.succeed(settings.token) }),
          ),
      );

      expect(message).not.toContain(Redacted.value(settings.token));
      expect((await stat(join(directory, "channels/discord.json"))).mode & 0o777).toBe(0o600);
      const loaded = await Effect.runPromise(loadDiscordSettings(directory));
      expect(loaded).toEqual(settings);
      expect(loaded && Redacted.value(loaded.token)).toBe("discord-secret");
      expect(JSON.stringify(loaded)).not.toContain("discord-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["", "x".repeat(8193)])(
    "setup rejects invalid tokens before writing settings",
    async (token) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-discord-input-"));

      try {
        const result = await Effect.runPromise(
          discord.setup(["setup", "100", "200", "300", "400", "--key-stdin"]).pipe(
            Effect.provideService(ChannelEnvironment, { dataDirectory: directory }),
            Effect.provideService(ChannelInput, {
              readSecret: Effect.succeed(Redacted.make(token)),
            }),
            Effect.result,
          ),
        );

        expect(result).toHaveProperty("failure.reason", "configuration");
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

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
