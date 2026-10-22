import { describe, expect, test } from "bun:test";
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Redacted, Schema } from "effect";

import { ChannelError, MessagingChannel } from "#src/channel";
import { ChannelEnvironment } from "#src/registration";
import { channelSettings, loadChannelSettings, saveChannelSettings } from "#src/settings";

import { makeFIFO } from "../../../tools/testing/fifo";

describe.concurrent("protected channel settings", () => {
  test("saves settings with protected permissions and repairs permissions when reading", async () => {
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
    "rejects %s settings without exposing their contents or changing link targets",
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

const testSettings = channelSettings(
  "test-channel",
  "Test channel",
  Schema.Struct({ token: Schema.RedactedFromValue(Schema.NonEmptyString) }),
);

describe.concurrent("channel settings loader", () => {
  test.each(["directory", "file"])("returns null for a missing settings %s", async (missing) => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-channel-loader-"));
    let imports = 0;

    const loader = testSettings.loader(async () => {
      imports++;

      throw new Error("Settings must be valid before importing the adapter");
    });

    try {
      if (missing === "file")
        await Effect.runPromise(saveChannelSettings(directory, "other", "{}"));

      expect(
        await Effect.runPromise(
          loader.pipe(Effect.provideService(ChannelEnvironment, { dataDirectory: directory })),
        ),
      ).toBeNull();
      expect(imports).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([
    { name: "malformed JSON", contents: "channel-secret" },
    { name: "invalid schema", contents: '{"token":123}' },
    { name: "excess properties", contents: '{"token":"channel-secret","extra":true}' },
    { name: "symlink", contents: "{}" },
  ])("rejects $name before importing the adapter", async ({ name, contents }) => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-channel-loader-invalid-"));
    let imports = 0;

    const loader = testSettings.loader(async () => {
      imports++;

      throw new Error("Settings must be valid before importing the adapter");
    });

    try {
      await Effect.runPromise(saveChannelSettings(directory, "test-channel", contents));

      if (name === "symlink") {
        const path = join(directory, "channels/test-channel.json");
        const target = join(directory, "target");
        await writeFile(target, '{"token":"channel-secret"}');
        await rm(path);
        await symlink(target, path);
      }

      const error = await Effect.runPromise(
        loader.pipe(
          Effect.provideService(ChannelEnvironment, { dataDirectory: directory }),
          Effect.flip,
        ),
      );

      expect(error).toBeInstanceOf(ChannelError);
      expect(error.reason).toBe("configuration");
      expect(error.message).toBe(
        "Cannot read or write protected Test channel settings. Run gateway test-channel setup again.",
      );
      expect(JSON.stringify(error)).not.toContain("channel-secret");
      expect(imports).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("passes decoded settings and the data directory only when building the layer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-channel-loader-lazy-"));
    const settings = { token: Redacted.make("channel-secret") };
    const failure = new ChannelError({ reason: "unavailable", message: "Connection failed" });
    let imports = 0;

    const loader = testSettings.loader(async (loaded, dataDirectory) => {
      imports++;
      expect(loaded).toEqual(settings);
      expect(dataDirectory).toBe(directory);

      return Layer.effect(MessagingChannel, Effect.fail(failure));
    });

    try {
      await Effect.runPromise(testSettings.save(directory, settings));

      const layer = await Effect.runPromise(
        loader.pipe(Effect.provideService(ChannelEnvironment, { dataDirectory: directory })),
      );

      expect(imports).toBe(0);
      expect(layer).not.toBeNull();

      if (layer === null) throw new Error("Expected a configured channel layer");
      const error = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped, Effect.flip));

      expect(imports).toBe(1);
      expect(error).toBe(failure);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
