import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChannelEnvironment, ChannelInput } from "@poppet/gateway";
import { Effect, Redacted } from "effect";

import { telegram } from "#src/registration";
import { loadTelegramSettings, saveTelegramSettings } from "#src/settings";

const settings = {
  version: 1 as const,
  botId: "100",
  ownerId: "200",
  token: Redacted.make("100:telegram-secret"),
};

describe.concurrent("Telegram settings", () => {
  test("setup saves protected settings offline without leaking the token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-telegram-"));

    try {
      expect(await Effect.runPromise(loadTelegramSettings(directory))).toBeNull();

      const message = await Effect.runPromise(
        telegram
          .setup(["setup", "100", "200", "--key-stdin"])
          .pipe(
            Effect.provideService(ChannelEnvironment, { dataDirectory: directory }),
            Effect.provideService(ChannelInput, { readSecret: Effect.succeed(settings.token) }),
          ),
      );

      expect(message).not.toContain(Redacted.value(settings.token));
      expect((await stat(join(directory, "channels/telegram.json"))).mode & 0o777).toBe(0o600);
      const loaded = await Effect.runPromise(loadTelegramSettings(directory));
      expect(loaded).toEqual(settings);
      expect(loaded && Redacted.value(loaded.token)).toBe("100:telegram-secret");
      expect(JSON.stringify(loaded)).not.toContain("telegram-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["", "x".repeat(8193)])(
    "setup rejects invalid tokens before writing settings",
    async (token) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-telegram-input-"));

      try {
        const result = await Effect.runPromise(
          telegram.setup(["setup", "100", "200", "--key-stdin"]).pipe(
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
    { name: "malformed JSON", contents: "telegram-secret" },
    {
      name: "unsafe owner ID",
      contents: JSON.stringify({
        ...settings,
        ownerId: "9007199254740992",
        token: "100:telegram-secret",
      }),
    },
  ])("rejects $name without exposing settings contents", async ({ contents }) => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-telegram-invalid-"));

    try {
      await Effect.runPromise(saveTelegramSettings(directory, settings));
      const path = join(directory, "channels/telegram.json");
      await writeFile(path, contents);
      const result = await Effect.runPromise(loadTelegramSettings(directory).pipe(Effect.result));
      expect(result).toHaveProperty("failure.reason", "configuration");
      expect(JSON.stringify(result)).not.toContain("telegram-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
