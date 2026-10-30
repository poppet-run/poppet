import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { BrowserSettings, browserFileValue } from "@poppet/browser/config";
import { acquireOwnerLock } from "@poppet/credentials/lock";
import { readProtectedFile, writeFileAtomic } from "@poppet/io";
import { MCPServers, mcpFileValue } from "@poppet/mcp/config";
import { Config, ConfigProvider, Context, Effect, Layer, Schema } from "effect";

export const ConfigText = Schema.NonEmptyString.check(Schema.isTrimmed());

export const dataDirectory = Config.schema(ConfigText, "POPPET_DATA_DIR").pipe(
  Config.withDefault(join(homedir(), ".config", "poppet")),
  Config.map((directory) => resolve(directory)),
);

export const DiscordConfiguration = Schema.Struct({
  ownerId: Schema.String.check(Schema.isPattern(/^\d{1,20}$/)),
  guildId: Schema.String.check(Schema.isPattern(/^\d{1,20}$/)),
  homeChannelId: Schema.String.check(Schema.isPattern(/^\d{1,20}$/)),
});

const FileSettings = Schema.Struct({
  discord: Schema.optionalKey(DiscordConfiguration),
  applicationName: Schema.optionalKey(ConfigText),
  provider: Schema.optionalKey(ConfigText),
  model: Schema.optionalKey(ConfigText),
  webSearch: Schema.optionalKey(Schema.Boolean),
  webSearchProvider: Schema.optionalKey(Schema.Literals(["brave", "kagi"])),
  browser: Schema.optionalKey(BrowserSettings),
  mcpServers: Schema.optionalKey(MCPServers),
  gatewayPackages: Schema.optionalKey(Schema.Array(ConfigText)),
  tasks: Schema.optionalKey(Schema.Struct({ catchUpMinutes: Schema.optionalKey(Schema.Int) })),
  chat: Schema.optionalKey(
    Schema.Struct({
      logReasoning: Schema.optionalKey(Schema.Boolean),
      logTimings: Schema.optionalKey(Schema.Boolean),
      outputTokens: Schema.optionalKey(Schema.Int),
      runDeadlineSeconds: Schema.optionalKey(Schema.Int),
      maxConcurrentRequests: Schema.optionalKey(Schema.Int),
    }),
  ),
});

/** Fingerprint of the file and data directory captured while loading this configuration. */
export class ConfigIdentity extends Context.Service<ConfigIdentity, string>()(
  "poppet/ConfigIdentity",
) {}

/** Describes the non-secret sources used by the current process. */
export class ConfigSource extends Context.Service<
  ConfigSource,
  {
    readonly configFile: { readonly path: string; readonly exists: boolean };
    readonly environmentOverrides: ReadonlyArray<string>;
    readonly discord: typeof DiscordConfiguration.Type | null;
  }
>()("poppet/ConfigSource") {}

const fileError = (path: string, message: string) =>
  new Config.ConfigError(new ConfigProvider.SourceError({ message: `${path}: ${message}` }));

/** Reads one optional file without creating directories or loading credentials. */
export const readConfigFile = (directory: string) =>
  Effect.gen(function* () {
    const path = join(directory, "config.json");

    const contents = yield* Effect.tryPromise({
      try: () => readProtectedFile(path, { maxBytes: 65536, ownerWriteOnly: true }),
      catch: () =>
        fileError(
          path,
          "Cannot read configuration. Use a file owned by you, without links or group/other write access, of at most 64 KiB.",
        ),
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

    return { file, path, exists: contents !== null };
  });

export const loadConfigSource = Effect.gen(function* () {
  const environment = yield* ConfigProvider.ConfigProvider;
  const directory = yield* dataDirectory;
  const { file, path, exists } = yield* readConfigFile(directory);

  const values = {
    POPPET_DATA_DIR: directory,
    applicationName: file.applicationName,
    provider: file.provider,
    model: file.model,
    webSearch: file.webSearch,
    webSearchProvider: file.webSearchProvider,
    browser: browserFileValue(file.browser, directory),
    mcpServers: mcpFileValue(file.mcpServers, directory),
    gatewayPackages:
      file.gatewayPackages === undefined ? undefined : JSON.stringify(file.gatewayPackages),
    catchUpMinutes: file.tasks?.catchUpMinutes,
    logReasoning: file.chat?.logReasoning,
    logTimings: file.chat?.logTimings,
    outputTokens: file.chat?.outputTokens,
    runDeadlineSeconds: file.chat?.runDeadlineSeconds,
    maxConcurrentRequests: file.chat?.maxConcurrentRequests,
  };

  const environmentOverrides =
    (yield* environment
      .load(["POPPET_DATA_DIR"])
      .pipe(Effect.mapError((error) => new Config.ConfigError(error)))) === undefined
      ? []
      : ["POPPET_DATA_DIR"];

  const saved = ConfigProvider.fromUnknown(values, { preserveEmptyStrings: true });

  return Context.make(ConfigSource, {
    configFile: { path, exists },
    discord: file.discord ?? null,
    environmentOverrides,
  }).pipe(
    Context.add(
      ConfigIdentity,
      createHash("sha256").update(JSON.stringify({ directory, file })).digest("hex"),
    ),
    Context.add(
      ConfigProvider.ConfigProvider,
      ConfigProvider.make((key) =>
        key.length === 1 && Object.hasOwn(values, String(key[0]))
          ? saved.load(key)
          : environment.load(key),
      ),
    ),
  );
});

export const ConfigSourceLive = Layer.effectContext(loadConfigSource);

/** Merge under a lock and replace atomically; never put credentials in this file. */
export const updateConfigFile = (
  directory: string,
  update: (file: typeof FileSettings.Type) => typeof FileSettings.Type,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => mkdir(directory, { recursive: true, mode: 0o700 }),
        catch: () => fileError(directory, "Cannot create configuration directory."),
      });
      yield* acquireOwnerLock(join(directory, "config.lock")).pipe(
        Effect.mapError(() => fileError(directory, "Configuration is busy or cannot be locked.")),
      );
      const { file, path } = yield* readConfigFile(directory);

      const changed = yield* Schema.decodeUnknownEffect(FileSettings, {
        onExcessProperty: "error",
      })(update(file)).pipe(
        Effect.mapError(() => fileError(path, "Invalid configuration update.")),
      );

      const contents = JSON.stringify(changed, null, 2) + "\n";

      if (Buffer.byteLength(contents) > 65536)
        return yield* Effect.fail(fileError(path, "Configuration exceeds 64 KiB."));
      yield* Effect.tryPromise({
        try: () => writeFileAtomic(path, contents),
        catch: () => fileError(path, "Cannot save configuration."),
      });

      return changed;
    }),
  ).pipe(Effect.uninterruptible);
