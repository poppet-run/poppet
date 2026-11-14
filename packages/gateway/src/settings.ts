import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { readConfigFile, updateConfigFile } from "@poppet/config";
import { acquireOwnerLock } from "@poppet/credentials/lock";
import { protectedFiles } from "@poppet/credentials/records";
import { Effect, Layer, Schema } from "effect";

import { ChannelError, type MessagingChannel } from "#src/channel";
import { ChannelEnvironment } from "#src/registration";

const settingsError = () =>
  new ChannelError({
    reason: "configuration",
    message: "Cannot read or write protected channel settings.",
  });

const filesFor = (dataDirectory: string, adapter: string) =>
  Effect.gen(function* () {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(adapter)) return yield* Effect.fail(settingsError());

    return protectedFiles(join(dataDirectory, "channels"), settingsError, 16384);
  });

export const loadChannelSettings = (dataDirectory: string, adapter: string) =>
  filesFor(dataDirectory, adapter).pipe(Effect.flatMap((files) => files.read(adapter)));

export const saveChannelSettings = (dataDirectory: string, adapter: string, contents: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (Buffer.byteLength(contents) > 16384) return yield* Effect.fail(settingsError());
      const files = yield* filesFor(dataDirectory, adapter);

      yield* files.lock(adapter).pipe(Effect.mapError(settingsError));
      yield* files.write(adapter, contents);
    }),
  ).pipe(Effect.uninterruptible);

export const channelSettings = <S extends Schema.Top>(
  adapter: string,
  label: string,
  schema: S,
) => {
  const SavedSettings = Schema.fromJsonString(schema);

  const failure = () =>
    new ChannelError({
      reason: "configuration",
      message: `Cannot read or write protected ${label} settings. Run gateway ${adapter} setup again.`,
    });

  const load = (dataDirectory: string) =>
    Effect.gen(function* () {
      const contents = yield* loadChannelSettings(dataDirectory, adapter);

      if (contents === null) return null;

      return yield* Schema.decodeUnknownEffect(SavedSettings, { onExcessProperty: "error" })(
        contents,
      );
    }).pipe(Effect.mapError(failure));

  return {
    load,
    loader: (
      createLayer: (
        settings: S["Type"],
        dataDirectory: string,
      ) => Promise<Layer.Layer<MessagingChannel, ChannelError>>,
    ) =>
      Effect.gen(function* () {
        const { dataDirectory } = yield* ChannelEnvironment;
        const settings = yield* load(dataDirectory);

        if (settings === null) return null;

        return Layer.unwrap(Effect.promise(() => createLayer(settings, dataDirectory)));
      }),
    save: (dataDirectory: string, settings: S["Type"]) =>
      Schema.encodeEffect(SavedSettings)(settings).pipe(
        Effect.flatMap((contents) => saveChannelSettings(dataDirectory, adapter, contents)),
        Effect.mapError(failure),
      ),
  };
};

export const configuredChannelSettings = <
  K extends "discord" | "slack",
  P extends Schema.Top & { readonly Type: object },
  C extends Schema.Top & { readonly Type: object },
>(
  adapter: K,
  label: string,
  policySchema: P,
  credentialSchema: C,
) => {
  const credentials = channelSettings(adapter, label, credentialSchema);

  const failure = () =>
    new ChannelError({
      reason: "configuration",
      message: `Cannot load ${label} configuration or credentials. Check config.json and run gateway ${adapter} setup again.`,
    });

  return {
    save: (directory: string, settings: P["Type"] & C["Type"]) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => mkdir(directory, { recursive: true, mode: 0o700 }),
            catch: failure,
          });
          yield* acquireOwnerLock(join(directory, `${adapter}-config.lock`));
          const policy = yield* Schema.decodeUnknownEffect(policySchema)(settings);
          yield* readConfigFile(directory);
          yield* credentials.save(directory, settings);
          yield* updateConfigFile(directory, (file) => ({ ...file, [adapter]: policy }));
        }),
      ).pipe(Effect.mapError(failure), Effect.uninterruptible),
    load: (directory: string) =>
      Effect.gen(function* () {
        const saved = yield* credentials.load(directory);

        if (saved === null) return null;
        const { file } = yield* readConfigFile(directory);

        if (file[adapter] === undefined) return null;
        const policy = yield* Schema.decodeUnknownEffect(policySchema)(file[adapter]);

        return { ...policy, ...saved };
      }).pipe(Effect.mapError(failure)),
  };
};
