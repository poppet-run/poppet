import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChannelEnvironment, ChannelInput } from "@poppet/gateway";
import { Effect } from "effect";

import { whatsapp } from "#src/registration";
import { loadWhatsAppSettings } from "#src/settings";

describe("settings.ts", () => {
  test("when setup receives phone numbers, validates and saves private settings without pairing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-whatsapp-settings-"));

    const setup = (phone: string) =>
      whatsapp.setup(["setup", phone, "447700900002"]).pipe(
        Effect.provideService(ChannelEnvironment, { dataDirectory: directory }),
        Effect.provideService(ChannelInput, {
          readSecret: Effect.die("WhatsApp setup must not read a secret"),
        }),
      );

    try {
      const invalid = await Effect.runPromise(setup("+447700900001").pipe(Effect.result));
      expect(invalid).toHaveProperty("failure.reason", "configuration");
      expect(await readdir(directory)).toEqual([]);

      await Effect.runPromise(setup("447700900001"));
      expect(await Effect.runPromise(loadWhatsAppSettings(directory))).toEqual({
        version: 1,
        accountPhone: "447700900001",
        ownerPhone: "447700900002",
      });
      expect((await stat(join(directory, "channels/whatsapp.json"))).mode & 0o777).toBe(0o600);
      expect((await readdir(join(directory, "channels"))).toSorted()).toEqual([
        "whatsapp.json",
        "whatsapp.lock.sqlite",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
