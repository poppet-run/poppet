import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { limit, timeoutSeconds } from "@poppet/io";
import { mcpServers } from "@poppet/mcp/config";
import { Config, ConfigProvider, Context, Effect, Schema } from "effect";

import { loadConfig, quietHours, taskCatchUpMinutes, timeZone } from "#src/config";
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
        timeZone: "Europe/London",
        tasks: {
          catchUpMinutes: 15,
          approvals: "wait",
          quietHours: { start: "22:00", end: "07:30", timeZone: "Europe/London" },
        },
        chat: { outputTokens: 4096 },
        timeouts: { mcpToolCallSeconds: 20 },
        limits: { toolBytes: 4096 },
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
          zone: timeZone,
          catchUp: taskCatchUpMinutes,
          quiet: quietHours,
          mcp: mcpServers,
          output: Config.schema(Schema.Int, "outputTokens"),
          secret: Config.String("POPPET_OPENROUTER_API_KEY"),
          toolCallSeconds: timeoutSeconds("mcpToolCallSeconds"),
          pageSeconds: timeoutSeconds("pageFetchSeconds"),
          toolBytes: limit("toolBytes"),
          contextBytes: limit("contextBytes"),
        }).pipe(Effect.provide(loaded.context)),
      );

      expect(resolved).toMatchObject({
        zone: "Europe/London",
        catchUp: 15,
        quiet: { start: "22:00", end: "07:30", timeZone: "Europe/London" },
        output: 4096,
        secret: "secret-key",
        mcp: [{ cwd: join(directory, "local") }],
        toolCallSeconds: 20,
        pageSeconds: 15,
        toolBytes: 4096,
        contextBytes: 262_144,
      });
      expect(JSON.stringify(loaded.source)).not.toContain("secret-key");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([
    ["malformed JSON", '{"token":"must-not-appear",'],
    ["removed internal limit", '{"chat":{"contextBytes":4096}}'],
    [
      "Discord token in ordinary config",
      '{"discord":{"ownerId":"2","guildId":"3","homeChannelId":"4","token":"must-not-appear"}}',
    ],
    ["unknown setting", '{"token":"must-not-appear"}'],
    ["unknown chat setting", '{"chat":{"outputToken":1024}}'],
    ["unknown timeout", '{"timeouts":{"searchSeconds":20}}'],
    ["timeout below its minimum", '{"timeouts":{"mcpToolCallSeconds":0}}'],
    ["limit above its maximum", '{"limits":{"toolBytes":1048576}}'],
    ["fractional limit", '{"limits":{"historyTurns":2.5}}'],
    ["data directory in file", '{"dataDirectory":"elsewhere"}'],
    ["wrong value type", '{"chat":{"outputTokens":"1024"}}'],
    ["wrong reasoning flag type", '{"chat":{"logReasoning":"true"}}'],
    ["wrong timing flag type", '{"chat":{"logTimings":"true"}}'],
    ["removed search provider brave", '{"webSearchProvider":"brave"}'],
    ["removed search provider kagi", '{"webSearchProvider":"kagi"}'],
    ["removed search flag enabled", '{"webSearch":true}'],
    ["removed search flag disabled", '{"webSearch":false}'],
    ["search credential in file", '{"braveSearchApiKey":"must-not-appear"}'],
    ["empty setting", '{"model":""}'],
    ["null setting", '{"model":null}'],
    ["unknown time zone", '{"timeZone":"Mars/Olympus"}'],
    ["non-object settings", "[]"],
    ["oversized file", " ".repeat(65_537)],
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

  test.each([
    [{ start: "7:30", end: "22:00", timeZone: "UTC" }, "Use a 24-hour HH:MM time"],
    [{ start: "22:00", end: "24:00", timeZone: "UTC" }, "Use a 24-hour HH:MM time"],
    [{ start: "22:00", end: "07:30", timeZone: "Mars/Olympus" }, "Use an IANA time zone"],
    [{ start: "22:00", end: "07:30", timeZone: "+01:00" }, "Use an IANA time zone"],
    [{ start: "22:00", end: "22:00", timeZone: "UTC" }, "Use different quiet-hours start"],
    [{ start: "22:00", end: "07:30" }, "timeZone"],
  ])("when quiet hours are %j, rejects them with %j", async (window, message) => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-quiet-hours-"));
    const path = join(directory, "config.json");

    try {
      await writeFile(path, JSON.stringify({ tasks: { quietHours: window } }));
      const error = await Effect.runPromise(load({ POPPET_DATA_DIR: directory }).pipe(Effect.flip));

      expect(error.message).toContain(path);
      expect(error.message).toContain(message);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("when quiet hours omit timeZone, uses the top-level timeZone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-quiet-hours-zone-"));

    try {
      await writeFile(
        join(directory, "config.json"),
        JSON.stringify({
          timeZone: "Europe/Paris",
          tasks: { quietHours: { start: "22:00", end: "07:30" } },
        }),
      );
      const loaded = await Effect.runPromise(load({ POPPET_DATA_DIR: directory }));

      expect(await Effect.runPromise(quietHours.pipe(Effect.provide(loaded.context)))).toEqual({
        start: "22:00",
        end: "07:30",
        timeZone: "Europe/Paris",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  test("when updating configuration in a symlinked or group-writable directory, rejects the directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poppet-config-update-"));

    try {
      const real = join(directory, "real");
      const linked = join(directory, "linked");
      await mkdir(real, { mode: 0o700 });
      await symlink(real, linked);

      await expect(
        Effect.runPromise(updateConfigFile(linked, (file) => ({ ...file, model: "m" }))),
      ).rejects.toHaveProperty("_tag", "ConfigError");

      await chmod(real, 0o770);
      await expect(
        Effect.runPromise(updateConfigFile(real, (file) => ({ ...file, model: "m" }))),
      ).rejects.toHaveProperty("_tag", "ConfigError");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
