import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { Config, ConfigProvider, Context, Effect, Layer, Schema } from "effect";

export const ConfigText = Schema.NonEmptyString.check(Schema.isTrimmed());

export const dataDirectory = Config.schema(ConfigText, "POPPET_DATA_DIR").pipe(
  Config.withDefault(join(homedir(), ".config", "poppet")),
  Config.map((directory) => resolve(directory)),
);

const FileSettings = Schema.Struct({
  applicationName: Schema.optionalKey(ConfigText),
  notesDirectory: Schema.optionalKey(ConfigText),
  provider: Schema.optionalKey(ConfigText),
  model: Schema.optionalKey(ConfigText),
  chat: Schema.optionalKey(
    Schema.Struct({
      contextBytes: Schema.optionalKey(Schema.Int),
      historyTurns: Schema.optionalKey(Schema.Int),
      outputTokens: Schema.optionalKey(Schema.Int),
      modelTurns: Schema.optionalKey(Schema.Int),
      toolCalls: Schema.optionalKey(Schema.Int),
      toolBytes: Schema.optionalKey(Schema.Int),
      soulBytes: Schema.optionalKey(Schema.Int),
      profileBytes: Schema.optionalKey(Schema.Int),
      factsBytes: Schema.optionalKey(Schema.Int),
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
    POPPET_NOTES_DIR:
      file.notesDirectory === undefined ? undefined : resolve(directory, file.notesDirectory),
    POPPET_PROVIDER: file.provider,
    POPPET_MODEL: file.model,
    POPPET_CONTEXT_BYTES: file.chat?.contextBytes,
    POPPET_HISTORY_TURNS: file.chat?.historyTurns,
    POPPET_OUTPUT_TOKENS: file.chat?.outputTokens,
    POPPET_MODEL_TURNS: file.chat?.modelTurns,
    POPPET_TOOL_CALLS: file.chat?.toolCalls,
    POPPET_TOOL_BYTES: file.chat?.toolBytes,
    POPPET_SOUL_BYTES: file.chat?.soulBytes,
    POPPET_PROFILE_BYTES: file.chat?.profileBytes,
    POPPET_FACTS_BYTES: file.chat?.factsBytes,
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

export const ConfigSourceLive = Layer.effectContext(loadConfigSource).pipe(
  Layer.provide(
    ConfigProvider.layer(Effect.sync(() => ConfigProvider.fromEnv({ preserveEmptyStrings: true }))),
  ),
);
