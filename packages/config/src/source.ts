import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { acquireOwnerLock, OwnerLockError } from "@poppet/credentials/lock";
import { readProtectedFile, writeFileAtomic } from "@poppet/io";
import { MCPServers, mcpFileValue } from "@poppet/mcp/config";
import { Config, ConfigProvider, Context, Effect, Layer, Schedule, Schema } from "effect";

import { QuietHoursSetting, TimeZone } from "#src/quiet-hours";

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

export const SlackConfiguration = Schema.Struct({
  ownerId: Schema.String.check(Schema.isPattern(/^[UW][A-Z0-9]+$/)),
  teamId: Schema.String.check(Schema.isPattern(/^T[A-Z0-9]+$/)),
  homeChannelId: Schema.String.check(Schema.isPattern(/^[CG][A-Z0-9]+$/)),
});

const FileSettings = Schema.Struct({
  discord: Schema.optionalKey(DiscordConfiguration),
  slack: Schema.optionalKey(SlackConfiguration),
  applicationName: Schema.optionalKey(ConfigText),
  provider: Schema.optionalKey(ConfigText),
  model: Schema.optionalKey(ConfigText),
  timeZone: Schema.optionalKey(TimeZone),
  mcpServers: Schema.optionalKey(MCPServers),
  gatewayPackages: Schema.optionalKey(Schema.Array(ConfigText)),
  tasks: Schema.optionalKey(
    Schema.Struct({
      catchUpMinutes: Schema.optionalKey(Schema.Int),
      quietHours: Schema.optionalKey(QuietHoursSetting),
    }),
  ),
  chat: Schema.optionalKey(
    Schema.Struct({
      logReasoning: Schema.optionalKey(Schema.Boolean),
      logTimings: Schema.optionalKey(Schema.Boolean),
      outputTokens: Schema.optionalKey(Schema.Int),
      runDeadlineSeconds: Schema.optionalKey(Schema.Int),
      maxConcurrentRequests: Schema.optionalKey(Schema.Int),
    }),
  ),
}).check(
  Schema.makeFilter(
    (file) =>
      file.tasks?.quietHours === undefined ||
      file.tasks.quietHours.timeZone !== undefined ||
      file.timeZone !== undefined ||
      "Set tasks.quietHours.timeZone or the top-level timeZone.",
  ),
);

export class ConfigIdentity extends Context.Service<ConfigIdentity, string>()(
  "poppet/ConfigIdentity",
) {}

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

export const readConfigFile = (directory: string) =>
  Effect.gen(function* () {
    const path = join(directory, "config.json");

    const contents = yield* Effect.tryPromise({
      try: () => readProtectedFile(path, { maxBytes: 65_536, ownerWriteOnly: true }),
      catch: () =>
        fileError(
          path,
          "Cannot read configuration. Use a file owned by you, without links or group/other write access, of at most 64 KiB.",
        ),
    });

    const json =
      contents === null
        ? {}
        : yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
          )(contents).pipe(Effect.mapError(() => fileError(path, "Expected valid JSON.")));

    const file = yield* Schema.decodeUnknownEffect(FileSettings, { onExcessProperty: "error" })(
      Object.fromEntries(Object.entries(json).filter(([key]) => key !== "browser")),
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
    timeZone: file.timeZone,
    mcpServers: mcpFileValue(file.mcpServers, directory),
    gatewayPackages:
      file.gatewayPackages === undefined ? undefined : JSON.stringify(file.gatewayPackages),
    catchUpMinutes: file.tasks?.catchUpMinutes,
    quietHours:
      file.tasks?.quietHours === undefined
        ? undefined
        : JSON.stringify({ timeZone: file.timeZone, ...file.tasks.quietHours }),
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

export const updateConfigFile = (
  directory: string,
  update: (file: typeof FileSettings.Type) => typeof FileSettings.Type,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const info = yield* Effect.tryPromise({
        try: async () => {
          await mkdir(directory, { recursive: true, mode: 0o700 });

          return lstat(directory);
        },
        catch: () => fileError(directory, "Cannot create configuration directory."),
      });

      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o022) !== 0
      ) {
        return yield* Effect.fail(fileError(directory, "Unsafe configuration directory."));
      }

      yield* acquireOwnerLock(join(directory, "config.lock")).pipe(
        Effect.retry({
          while: (error) => error instanceof OwnerLockError && error.reason === "busy",
          schedule: Schedule.spaced("20 millis"),
          times: 10,
        }),
        Effect.mapError(() => fileError(directory, "Configuration is busy or cannot be locked.")),
      );
      const { file, path } = yield* readConfigFile(directory);

      const changed = yield* Schema.decodeUnknownEffect(FileSettings, {
        onExcessProperty: "error",
      })(update(file)).pipe(
        Effect.mapError(() => fileError(path, "Invalid configuration update.")),
      );

      const contents = JSON.stringify(changed, null, 2) + "\n";

      if (Buffer.byteLength(contents) > 65_536) {
        return yield* Effect.fail(fileError(path, "Configuration exceeds 64 KiB."));
      }

      yield* Effect.tryPromise({
        try: () => writeFileAtomic(path, contents),
        catch: () => fileError(path, "Cannot save configuration."),
      }).pipe(Effect.uninterruptible);

      return changed;
    }),
  );
