import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { mcpServers } from "@poppet/mcp/config";
import { Config, ConfigProvider, Context, Effect, Schema } from "effect";

import { browserSettings, loadConfig, webSearchEnabled } from "#src/config";
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
  test("browser defaults off, resolves a file executable, and honors complete environment replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-browser-config-"));

    try {
      const defaults = await Effect.runPromise(load({ POPPET_DATA_DIR: directory }));
      expect(
        await Effect.runPromise(browserSettings.pipe(Effect.provide(defaults.context))),
      ).toEqual({ enabled: false });
      await writeFile(
        join(directory, "config.json"),
        JSON.stringify({
          browser: {
            enabled: true,
            command: "bin/agent-browser",
            chromiumExecutable: "/opt/chromium",
            allowedDomains: ["example.com"],
          },
        }),
      );
      const file = await Effect.runPromise(load({ POPPET_DATA_DIR: directory }));
      expect(
        await Effect.runPromise(browserSettings.pipe(Effect.provide(file.context))),
      ).toMatchObject({
        enabled: true,
        command: join(directory, "bin/agent-browser"),
        allowedDomains: ["example.com"],
      });

      const overridden = await Effect.runPromise(
        load({ POPPET_DATA_DIR: directory, POPPET_BROWSER: '{"enabled":false}' }),
      );

      expect(
        await Effect.runPromise(browserSettings.pipe(Effect.provide(overridden.context))),
      ).toEqual({ enabled: false });
      expect(overridden.source.environmentOverrides).toContain("POPPET_BROWSER");

      await Promise.all(
        [
          "",
          '{"enabled":true}',
          '{"enabled":true,"chromiumExecutable":"/chrome","allowedDomains":["*.example.com"]}',
          '{"enabled":false,"extraArgs":[]}',
        ].map(async (value) => {
          const invalid = await Effect.runPromise(
            load({ POPPET_DATA_DIR: directory, POPPET_BROWSER: value }),
          );

          await expect(
            Effect.runPromise(browserSettings.pipe(Effect.provide(invalid.context))),
          ).rejects.toHaveProperty("_tag", "ConfigError");
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("MCP defaults to no servers, resolves file paths, and environment replacement preserves disabled servers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-mcp-config-"));

    const server = {
      id: "local",
      enabled: true,
      command: "/usr/bin/example",
      args: ["server"],
      cwd: "local",
      tools: ["read", "write"],
      scheduledTools: ["read"],
      environment: { TOKEN: { credential: "mcp-local" } },
    };

    try {
      const initial = await Effect.runPromise(load({ POPPET_DATA_DIR: directory }));
      expect(await Effect.runPromise(mcpServers.pipe(Effect.provide(initial.context)))).toEqual([]);
      await writeFile(join(directory, "config.json"), JSON.stringify({ mcpServers: [server] }));
      const file = await Effect.runPromise(load({ POPPET_DATA_DIR: directory }));
      expect(await Effect.runPromise(mcpServers.pipe(Effect.provide(file.context)))).toEqual([
        { ...server, cwd: join(directory, "local") },
      ]);

      const overridden = await Effect.runPromise(
        load({
          POPPET_DATA_DIR: directory,
          POPPET_MCP_SERVERS: JSON.stringify([{ ...server, enabled: false }]),
        }),
      );

      expect(
        (await Effect.runPromise(mcpServers.pipe(Effect.provide(overridden.context))))[0],
      ).toMatchObject({ enabled: false });

      const disabled = await Effect.runPromise(
        load({ POPPET_DATA_DIR: directory, POPPET_MCP_SERVERS: "[]" }),
      );

      expect(await Effect.runPromise(mcpServers.pipe(Effect.provide(disabled.context)))).toEqual(
        [],
      );
      expect(disabled.source.environmentOverrides).toContain("POPPET_MCP_SERVERS");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("web search is opt-in and environment overrides the file without exposing keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-search-config-"));

    try {
      const defaults = await Effect.runPromise(load({ POPPET_DATA_DIR: directory }));
      expect(await Effect.runPromise(webSearchEnabled.pipe(Effect.provide(defaults.context)))).toBe(
        false,
      );
      await writeFile(join(directory, "config.json"), '{"webSearch":true}');
      const file = await Effect.runPromise(load({ POPPET_DATA_DIR: directory }));
      expect(await Effect.runPromise(webSearchEnabled.pipe(Effect.provide(file.context)))).toBe(
        true,
      );

      const overridden = await Effect.runPromise(
        load({
          POPPET_DATA_DIR: directory,
          POPPET_WEB_SEARCH: "false",
          POPPET_BRAVE_SEARCH_API_KEY: "must-not-appear",
        }),
      );

      expect(
        await Effect.runPromise(webSearchEnabled.pipe(Effect.provide(overridden.context))),
      ).toBe(false);
      expect(overridden.source.environmentOverrides).toEqual([
        "POPPET_DATA_DIR",
        "POPPET_WEB_SEARCH",
      ]);

      const invalid = await Effect.runPromise(
        load({ POPPET_DATA_DIR: directory, POPPET_WEB_SEARCH: "" }),
      );

      await expect(
        Effect.runPromise(webSearchEnabled.pipe(Effect.provide(invalid.context))),
      ).rejects.toHaveProperty("_tag", "ConfigError");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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
    ["wrong reasoning flag type", '{"chat":{"logReasoning":"true"}}'],
    ["wrong timing flag type", '{"chat":{"logTimings":"true"}}'],
    ["wrong search flag type", '{"webSearch":"true"}'],
    ["search credential in file", '{"braveSearchApiKey":"must-not-appear"}'],
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
