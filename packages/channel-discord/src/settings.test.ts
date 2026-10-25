import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChannelEnvironment, ChannelInput } from "@poppet/gateway";
import { Effect, Redacted } from "effect";
import { describe, expect, test } from "vitest";

import { discord } from "#src/registration";
import { loadDiscordSettings, saveDiscordSettings } from "#src/settings";

const settings = {
  ownerId: "200",
  guildId: "300",
  homeChannelId: "400",
  token: Redacted.make("discord-secret"),
};

describe.concurrent("settings.ts", () => {
  test("when Discord setup receives valid settings, saves them privately without network access or token disclosure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-discord-"));

    try {
      expect(await Effect.runPromise(loadDiscordSettings(directory))).toBeNull();

      const message = await Effect.runPromise(
        discord
          .setup(["setup", "200", "300", "400", "--key-stdin"])
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

  test("saving preserves other settings and loading uses only the configured policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-discord-policy-"));
    const { token: _token, ...policy } = settings;

    try {
      await writeFile(join(directory, "config.json"), JSON.stringify({ model: "saved-model" }));
      await Effect.runPromise(saveDiscordSettings(directory, settings));
      const config = await readFile(join(directory, "config.json"), "utf8");
      const credentials = await readFile(join(directory, "channels/discord.json"), "utf8");
      expect(JSON.parse(config)).toEqual({ model: "saved-model", discord: policy });
      expect(config).not.toContain("discord-secret");
      expect(JSON.parse(credentials)).toEqual({ token: "discord-secret" });
      expect(await Effect.runPromise(loadDiscordSettings(directory))).toEqual(settings);
      expect(await readFile(join(directory, "config.json"), "utf8")).toBe(config);
      expect(await readFile(join(directory, "channels/discord.json"), "utf8")).toBe(credentials);
      await writeFile(join(directory, "config.json"), JSON.stringify({ model: "saved-model" }));
      expect(await Effect.runPromise(loadDiscordSettings(directory))).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("invalid configuration prevents replacing saved credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-discord-save-failure-"));

    try {
      await Effect.runPromise(saveDiscordSettings(directory, settings));
      const path = join(directory, "channels/discord.json");
      const credentials = await readFile(path, "utf8");
      await writeFile(join(directory, "config.json"), '{"unknown":true}');
      await expect(
        Effect.runPromise(
          saveDiscordSettings(directory, {
            ...settings,
            token: Redacted.make("replacement-secret"),
          }),
        ),
      ).rejects.toHaveProperty("reason", "configuration");
      expect(await readFile(path, "utf8")).toBe(credentials);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["", "x".repeat(8193)])(
    "when the Discord token is invalid in case %#, rejects setup before writing settings",
    async (token) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-discord-input-"));

      try {
        const result = await Effect.runPromise(
          discord.setup(["setup", "200", "300", "400", "--key-stdin"]).pipe(
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
    { name: "malformed JSON", file: "channels/discord.json", contents: "discord-secret" },
    {
      name: "empty home channel",
      file: "config.json",
      contents: JSON.stringify({
        discord: { ownerId: "200", guildId: "300", homeChannelId: "" },
      }),
    },
    {
      name: "combined policy and credentials",
      file: "channels/discord.json",
      contents: JSON.stringify({ ...settings, token: "discord-secret" }),
    },
  ])(
    "when Discord settings contain $name, rejects them without exposing their contents",
    async ({ file, contents }) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-discord-invalid-"));

      try {
        await Effect.runPromise(saveDiscordSettings(directory, settings));
        const path = join(directory, file);
        await writeFile(path, contents);
        const result = await Effect.runPromise(loadDiscordSettings(directory).pipe(Effect.result));
        expect(result).toHaveProperty("failure.reason", "configuration");
        expect(JSON.stringify(result)).not.toContain("discord-secret");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
