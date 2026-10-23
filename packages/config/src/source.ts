import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { BrowserSettings, browserFileValue } from "@poppet/browser/config";
import { MCPServers, mcpFileValue } from "@poppet/mcp/config";
import { Config, ConfigProvider, Context, Effect, Layer, Schema } from "effect";

export const ConfigText = Schema.NonEmptyString.check(Schema.isTrimmed());

export const dataDirectory = Config.schema(ConfigText, "POPPET_DATA_DIR").pipe(
  Config.withDefault(join(homedir(), ".config", "poppet")),
  Config.map((directory) => resolve(directory)),
);

const FileSettings = Schema.Struct({
  applicationName: Schema.optionalKey(ConfigText),
  provider: Schema.optionalKey(ConfigText),
  model: Schema.optionalKey(ConfigText),
  webSearch: Schema.optionalKey(Schema.Boolean),
  webSearchProvider: Schema.optionalKey(Schema.Literals(["brave", "kagi"])),
  browser: Schema.optionalKey(BrowserSettings),
  mcpServers: Schema.optionalKey(MCPServers),
  tasks: Schema.optionalKey(Schema.Struct({ catchUpMinutes: Schema.optionalKey(Schema.Int) })),
  chat: Schema.optionalKey(
    Schema.Struct({
      logReasoning: Schema.optionalKey(Schema.Boolean),
      logTimings: Schema.optionalKey(Schema.Boolean),
      contextBytes: Schema.optionalKey(Schema.Int),
      historyTurns: Schema.optionalKey(Schema.Int),
      outputTokens: Schema.optionalKey(Schema.Int),
      modelTurns: Schema.optionalKey(Schema.Int),
      toolCalls: Schema.optionalKey(Schema.Int),
      toolBytes: Schema.optionalKey(Schema.Int),
      soulBytes: Schema.optionalKey(Schema.Int),
      profileBytes: Schema.optionalKey(Schema.Int),
      factsBytes: Schema.optionalKey(Schema.Int),
      skillIndexBytes: Schema.optionalKey(Schema.Int),
      learnSkills: Schema.optionalKey(Schema.Boolean),
      learnMemory: Schema.optionalKey(Schema.Boolean),
      learnReview: Schema.optionalKey(Schema.Boolean),
      reviewMinToolCalls: Schema.optionalKey(Schema.Int),
      reviewTurnInterval: Schema.optionalKey(Schema.Int),
      reviewInputBytes: Schema.optionalKey(Schema.Int),
      reviewMaxAgeHours: Schema.optionalKey(Schema.Int),
      runDeadlineSeconds: Schema.optionalKey(Schema.Int),
    }),
  ),
});

/** Describes the non-secret sources used by the current process. */
export class ConfigSource extends Context.Service<
  ConfigSource,
  {
    readonly configFile: { readonly path: string; readonly exists: boolean };
    readonly environmentOverrides: ReadonlyArray<string>;
  }
>()("poppet/ConfigSource") {}

const MissingFile = Schema.Struct({ code: Schema.Literal("ENOENT") });

const fileError = (path: string, message: string) =>
  new Config.ConfigError(new ConfigProvider.SourceError({ message: `${path}: ${message}` }));

/** Reads one optional file without creating directories or loading credentials. */
export const loadConfigSource = Effect.gen(function* () {
  const environment = yield* ConfigProvider.ConfigProvider;
  const directory = yield* dataDirectory;
  const path = join(directory, "config.json");

  const contents = yield* Effect.tryPromise({
    try: async () => {
      const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(
        (cause: unknown) => {
          if (Schema.is(MissingFile)(cause)) return null;
          throw cause;
        },
      );

      if (handle === null) return null;

      try {
        const info = await handle.stat();

        if (!info.isFile() || info.size > 65536) throw new Error("Invalid configuration file");
        const text = await handle.readFile("utf8");

        if (Buffer.byteLength(text) > 65536) throw new Error("Configuration exceeds 64 KiB");

        return text;
      } finally {
        await handle.close();
      }
    },
    catch: () =>
      fileError(path, "Cannot read configuration. Use a regular file of at most 64 KiB."),
  });

  const json =
    contents === null
      ? {}
      : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(contents).pipe(
          Effect.mapError(() => fileError(path, "Expected valid JSON.")),
        );

  const file = yield* Schema.decodeUnknownEffect(FileSettings, { onExcessProperty: "error" })(
    json,
  ).pipe(Effect.mapError((error) => fileError(path, error.message)));

  const values = {
    POPPET_APP_NAME: file.applicationName,
    POPPET_PROVIDER: file.provider,
    POPPET_MODEL: file.model,
    POPPET_WEB_SEARCH: file.webSearch,
    POPPET_WEB_SEARCH_PROVIDER: file.webSearchProvider,
    POPPET_BROWSER: browserFileValue(file.browser, directory),
    POPPET_MCP_SERVERS: mcpFileValue(file.mcpServers, directory),
    POPPET_TASK_CATCH_UP_MINUTES: file.tasks?.catchUpMinutes,
    POPPET_LOG_REASONING: file.chat?.logReasoning,
    POPPET_LOG_TIMINGS: file.chat?.logTimings,
    POPPET_CONTEXT_BYTES: file.chat?.contextBytes,
    POPPET_HISTORY_TURNS: file.chat?.historyTurns,
    POPPET_OUTPUT_TOKENS: file.chat?.outputTokens,
    POPPET_MODEL_TURNS: file.chat?.modelTurns,
    POPPET_TOOL_CALLS: file.chat?.toolCalls,
    POPPET_TOOL_BYTES: file.chat?.toolBytes,
    POPPET_SOUL_BYTES: file.chat?.soulBytes,
    POPPET_PROFILE_BYTES: file.chat?.profileBytes,
    POPPET_FACTS_BYTES: file.chat?.factsBytes,
    POPPET_SKILL_INDEX_BYTES: file.chat?.skillIndexBytes,
    POPPET_LEARN_SKILLS: file.chat?.learnSkills,
    POPPET_LEARN_MEMORY: file.chat?.learnMemory,
    POPPET_LEARN_REVIEW: file.chat?.learnReview,
    POPPET_REVIEW_MIN_TOOL_CALLS: file.chat?.reviewMinToolCalls,
    POPPET_REVIEW_TURN_INTERVAL: file.chat?.reviewTurnInterval,
    POPPET_REVIEW_INPUT_BYTES: file.chat?.reviewInputBytes,
    POPPET_REVIEW_MAX_AGE_HOURS: file.chat?.reviewMaxAgeHours,
    POPPET_RUN_DEADLINE_SECONDS: file.chat?.runDeadlineSeconds,
  };

  const environmentOverrides = yield* Effect.filter(
    ["POPPET_DATA_DIR", ...Object.keys(values)],
    (key) => environment.load([key]).pipe(Effect.map((node) => node !== undefined)),
  ).pipe(Effect.mapError((error) => new Config.ConfigError(error)));

  return Context.make(ConfigSource, {
    configFile: { path, exists: contents !== null },
    environmentOverrides,
  }).pipe(
    Context.add(
      ConfigProvider.ConfigProvider,
      ConfigProvider.orElse(
        environment,
        ConfigProvider.fromUnknown(values, { preserveEmptyStrings: true }),
      ),
    ),
  );
});

export const ConfigSourceLive = Layer.effectContext(loadConfigSource);
