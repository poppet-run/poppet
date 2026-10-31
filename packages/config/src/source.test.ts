import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mcpServers } from "@poppet/mcp/config";
import { Config, ConfigProvider, Context, Effect, Schema } from "effect";

import { loadConfig, taskCatchUpMinutes, webSearchProvider } from "#src/config";
import { ConfigSource, loadConfigSource, updateConfigFile } from "#src/source";

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

describe("loadConfigSource", () => {
  test("file settings control the host while only the data directory and secrets come from the environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-file-config-"));

    try {
      const initial = await Effect.runPromise(load({ POPPET_DATA_DIR: directory }));
      expect(initial.settings.model).toBeNull();
      expect(await readdir(directory)).toEqual([]);

      const file = {
        provider: "other-provider",
        model: "file-model",
        webSearch: true,
        webSearchProvider: "kagi",
        tasks: { catchUpMinutes: 15 },
        chat: { outputTokens: 4096 },
        browser: { enabled: true, command: "bin/browser", allowedDomains: ["example.com"] },
        mcpServers: [
          {
            id: "local",
            enabled: true,
            command: "server",
            args: [],
            cwd: "local",
            tools: ["read"],
            scheduledTools: ["read"],
          },
        ],
      };

      await writeFile(join(directory, "config.json"), JSON.stringify(file));

      const loaded = await Effect.runPromise(
        load({
          POPPET_DATA_DIR: directory,
          POPPET_PROVIDER: "",
          POPPET_MODEL: "wrong",
          POPPET_WEB_SEARCH: "false",
          POPPET_WEB_SEARCH_PROVIDER: "unknown",
          POPPET_BROWSER: '{"enabled":false}',
          POPPET_MCP_SERVERS: "[]",
          POPPET_TASK_CATCH_UP_MINUTES: "1441",
          POPPET_OUTPUT_TOKENS: "0",
          POPPET_OPENROUTER_API_KEY: "secret-key",
        }),
      );

      expect(loaded.settings).toMatchObject({ provider: "other-provider", model: "file-model" });
      expect(loaded.source).toEqual({
        configFile: { path: join(directory, "config.json"), exists: true },
        environmentOverrides: ["POPPET_DATA_DIR"],
        discord: null,
      });

      const resolved = await Effect.runPromise(
        Effect.all({
          provider: webSearchProvider,
          catchUp: taskCatchUpMinutes,
          mcp: mcpServers,
          output: Config.schema(Schema.Int, "outputTokens"),
          secret: Config.String("POPPET_OPENROUTER_API_KEY"),
        }).pipe(Effect.provide(loaded.context)),
      );

      expect(resolved).toMatchObject({
        provider: "kagi",
        catchUp: 15,
        output: 4096,
        secret: "secret-key",
        mcp: [{ cwd: join(directory, "local") }],
      });
      expect(JSON.stringify(loaded.source)).not.toContain("secret-key");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([
    [{}, null],
    [{ webSearchProvider: "brave" }, "brave"],
    [{ webSearchProvider: "kagi" }, "kagi"],
    [{ webSearch: true }, "brave"],
    [{ webSearch: true, webSearchProvider: "kagi" }, "kagi"],
    [{ webSearch: false }, null],
    [{ webSearch: false, webSearchProvider: "brave" }, null],
    [{ webSearch: false, webSearchProvider: "kagi" }, null],
  ] as const)(
    "search config %j resolves to %j and saves without the legacy flag",
    async (search, expected) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-search-config-"));
      const path = join(directory, "config.json");
      const contents = JSON.stringify({ model: "saved-model", ...search });

      try {
        await writeFile(path, contents);
        const loaded = await Effect.runPromise(load({ POPPET_DATA_DIR: directory }));
        expect(
          await Effect.runPromise(webSearchProvider.pipe(Effect.provide(loaded.context))),
        ).toBe(expected);
        expect(await readFile(path, "utf8")).toBe(contents);

        await Effect.runPromise(
          updateConfigFile(directory, (file) => ({ ...file, applicationName: "Updated" })),
        );
        const saved = JSON.parse(await readFile(path, "utf8"));
        expect(saved).toEqual(
          expected === null
            ? { model: "saved-model", applicationName: "Updated" }
            : { model: "saved-model", applicationName: "Updated", webSearchProvider: expected },
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test.each([
    ["malformed JSON", '{"token":"must-not-appear",'],
    ["removed internal limit", '{"chat":{"contextBytes":4096}}'],
    [
      "Discord token in ordinary config",
      '{"discord":{"ownerId":"2","guildId":"3","homeChannelId":"4","token":"must-not-appear"}}',
    ],
    ["unknown setting", '{"token":"must-not-appear"}'],
    ["unknown chat setting", '{"chat":{"outputToken":1024}}'],
    ["data directory in file", '{"dataDirectory":"elsewhere"}'],
    ["wrong value type", '{"chat":{"outputTokens":"1024"}}'],
    ["wrong reasoning flag type", '{"chat":{"logReasoning":"true"}}'],
    ["wrong timing flag type", '{"chat":{"logTimings":"true"}}'],
    ["unknown search provider", '{"webSearchProvider":"unknown"}'],
    ["empty search provider", '{"webSearchProvider":""}'],
    ["null search provider", '{"webSearchProvider":null}'],
    ["wrong search flag type", '{"webSearch":"true"}'],
    ["search credential in file", '{"braveSearchApiKey":"must-not-appear"}'],
    ["empty setting", '{"model":""}'],
    ["null setting", '{"model":null}'],
    ["non-object settings", "[]"],
    ["oversized file", " ".repeat(65537)],
  ])(
    "when configuration contains %s, rejects it without printing file contents",
    async (_, contents) => {
      const directory = await mkdtemp(join(tmpdir(), "poppet-config-invalid-"));
      const path = join(directory, "config.json");

      try {
        await writeFile(path, contents);

        const error = await Effect.runPromise(
          load({ POPPET_DATA_DIR: directory }).pipe(Effect.flip),
        );

        expect(error).toHaveProperty("_tag", "ConfigError");
        expect(error.message).toContain(path);
        expect(error.message).not.toContain("must-not-appear");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("authorization configuration rejects symlinks and files writable by other users", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-config-permissions-"));

    try {
      const path = join(directory, "config.json");
      const target = join(directory, "target.json");
      await writeFile(target, "{}");
      await symlink(target, path);
      await expect(Effect.runPromise(load({ POPPET_DATA_DIR: directory }))).rejects.toHaveProperty(
        "_tag",
        "ConfigError",
      );
      await rm(path);
      await writeFile(path, "{}");
      await chmod(path, 0o666);
      await expect(Effect.runPromise(load({ POPPET_DATA_DIR: directory }))).rejects.toHaveProperty(
        "_tag",
        "ConfigError",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when the configuration file is unreadable, fails instead of treating it as missing", async () => {
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
