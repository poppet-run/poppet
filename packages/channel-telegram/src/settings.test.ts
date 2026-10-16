import { describe, expect, test } from "bun:test";
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  test("loads protected settings without leaking the token in application values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-telegram-"));

    try {
      expect(await Effect.runPromise(loadTelegramSettings(directory))).toBeNull();
      await Effect.runPromise(saveTelegramSettings(directory, settings));
      expect((await stat(join(directory, "channels"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, "channels/telegram.json"))).mode & 0o777).toBe(0o600);
      const loaded = await Effect.runPromise(loadTelegramSettings(directory));
      expect(loaded?.ownerId).toBe("200");
      expect(loaded && Redacted.value(loaded.token)).toBe("100:telegram-secret");
      expect(JSON.stringify(loaded)).not.toContain("telegram-secret");
      await chmod(join(directory, "channels/telegram.json"), 0o644);
      await Effect.runPromise(loadTelegramSettings(directory));
      expect((await stat(join(directory, "channels/telegram.json"))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["symlink", "hardlink", "oversized", "invalid"])(
    "rejects %s settings without exposing their contents",
    async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-telegram-invalid-"));

      try {
        await Effect.runPromise(saveTelegramSettings(directory, settings));
        const path = join(directory, "channels/telegram.json");
        const other = join(directory, "other");
        await writeFile(other, await readFile(path));
        await rm(path);

        if (kind === "symlink") await symlink(other, path);
        else if (kind === "hardlink") await link(other, path);
        else
          await writeFile(
            path,
            kind === "oversized" ? "telegram-secret".repeat(2000) : "telegram-secret",
          );
        const result = await Effect.runPromise(loadTelegramSettings(directory).pipe(Effect.result));
        expect(result).toHaveProperty("failure.reason", "configuration");
        expect(JSON.stringify(result)).not.toContain("telegram-secret");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
