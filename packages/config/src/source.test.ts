import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Config, ConfigProvider, Context, Effect, Schema } from "effect";

import { loadConfig } from "#src/config";
import { ConfigSource, loadConfigSource } from "#src/source";

const load = (environment: Record<string, string>) =>
  Effect.gen(function* () {
    const context = yield* loadConfigSource;

    return {
      settings: yield* loadConfig("test-provider", ["test-provider", "other-provider"]).pipe(
        Effect.provide(context),
      ),
      source: Context.get(context, ConfigSource),
      context,
    };
  }).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ env: environment, preserveEmptyStrings: true }),
    ),
  );

describe("configuration sources", () => {
  test("a missing file keeps defaults and does not create the data directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-config-"));
    const data = join(directory, "missing");

    try {
      const result = await Effect.runPromise(load({ POPPET_DATA_DIR: data }));

      expect(result.settings).toMatchObject({
        dataDirectory: data,
        notesDirectory: join(data, "notes"),
        provider: "test-provider",
        model: null,
      });
      expect(result.source).toEqual({
        configFile: { path: join(data, "config.json"), exists: false },
        environmentOverrides: ["POPPET_DATA_DIR"],
      });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("file settings resolve paths beside the file and environment overrides win per field", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-config-"));

    try {
      await writeFile(
        join(directory, "config.json"),
        JSON.stringify({
          applicationName: "File name",
          notesDirectory: "local-notes",
          provider: "other-provider",
          model: "file-model",
          chat: { outputTokens: 4096, toolCalls: 4 },
        }),
      );
      const file = await Effect.runPromise(load({ POPPET_DATA_DIR: directory }));

      expect(file.settings).toEqual({
        applicationName: "File name",
        dataDirectory: directory,
        notesDirectory: join(directory, "local-notes"),
        provider: "other-provider",
        model: "file-model",
      });

      const overridden = await Effect.runPromise(
        load({
          POPPET_DATA_DIR: directory,
          POPPET_APP_NAME: "Environment name",
          POPPET_NOTES_DIR: "relative-notes",
          POPPET_OUTPUT_TOKENS: "1024",
          POPPET_OPENROUTER_API_KEY: "must-not-appear",
        }),
      );

      expect(overridden.settings).toEqual({
        ...file.settings,
        applicationName: "Environment name",
        notesDirectory: resolve("relative-notes"),
      });
      expect(overridden.source).toEqual({
        configFile: { path: join(directory, "config.json"), exists: true },
        environmentOverrides: [
          "POPPET_DATA_DIR",
          "POPPET_APP_NAME",
          "POPPET_NOTES_DIR",
          "POPPET_OUTPUT_TOKENS",
        ],
      });
      expect(
        await Effect.runPromise(
          Config.all({
            outputTokens: Config.schema(Schema.Int, "POPPET_OUTPUT_TOKENS"),
            toolCalls: Config.schema(Schema.Int, "POPPET_TOOL_CALLS"),
          }).pipe(Effect.provide(overridden.context)),
        ),
      ).toEqual({ outputTokens: 1024, toolCalls: 4 });
      expect(await readdir(directory)).toEqual(["config.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("empty and invalid environment values never fall back to valid file settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-config-"));

    try {
      await writeFile(
        join(directory, "config.json"),
        JSON.stringify({ provider: "other-provider", model: "file-model" }),
      );

      await Promise.all(
        [{ POPPET_PROVIDER: "" }, { POPPET_PROVIDER: "unknown" }, { POPPET_MODEL: " " }].map(
          (override) =>
            expect(
              Effect.runPromise(load({ POPPET_DATA_DIR: directory, ...override })),
            ).rejects.toHaveProperty("_tag", "ConfigError"),
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([
    ["malformed JSON", '{"token":"must-not-appear",'],
    ["unknown setting", '{"token":"must-not-appear"}'],
    ["unknown chat setting", '{"chat":{"outputToken":1024}}'],
    ["data directory in file", '{"dataDirectory":"elsewhere"}'],
    ["wrong value type", '{"chat":{"outputTokens":"1024"}}'],
    ["empty setting", '{"model":""}'],
    ["null setting", '{"model":null}'],
    ["non-object settings", "[]"],
    ["oversized file", " ".repeat(65537)],
  ])("rejects %s without printing file contents", async (_, contents) => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-config-invalid-"));
    const path = join(directory, "config.json");

    try {
      await writeFile(path, contents);

      const error = await Effect.runPromise(load({ POPPET_DATA_DIR: directory }).pipe(Effect.flip));

      expect(error).toHaveProperty("_tag", "ConfigError");
      expect(error.message).toContain(path);
      expect(error.message).not.toContain("must-not-appear");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("unreadable configuration fails instead of being treated as a missing file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-config-unreadable-"));

    try {
      await mkdir(join(directory, "config.json"));
      await expect(Effect.runPromise(load({ POPPET_DATA_DIR: directory }))).rejects.toMatchObject({
        message: expect.stringContaining("Cannot read configuration"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
