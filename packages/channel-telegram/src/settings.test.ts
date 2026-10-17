import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Redacted } from "effect";

import { loadTelegramSettings, saveTelegramSettings } from "#src/settings";

const settings = {
  version: 1 as const,
  botId: "100",
  ownerId: "200",
  token: Redacted.make("100:telegram-secret"),
};

describe.concurrent("Telegram settings", () => {
  test("round-trips settings without leaking the token in application values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-telegram-"));

    try {
      expect(await Effect.runPromise(loadTelegramSettings(directory))).toBeNull();
      await Effect.runPromise(saveTelegramSettings(directory, settings));
      const loaded = await Effect.runPromise(loadTelegramSettings(directory));
      expect(loaded).toEqual(settings);
      expect(loaded && Redacted.value(loaded.token)).toBe("100:telegram-secret");
      expect(JSON.stringify(loaded)).not.toContain("telegram-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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
