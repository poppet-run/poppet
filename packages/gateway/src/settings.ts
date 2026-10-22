import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { acquireOwnerLock } from "@poppet/credentials/lock";
import { Effect, Layer, Schema } from "effect";

import { ChannelError, type MessagingChannel } from "#src/channel";
import { ChannelEnvironment } from "#src/registration";

const MissingFile = Schema.Struct({ code: Schema.Literal("ENOENT") });

const settingsError = () =>
  new ChannelError({
    reason: "configuration",
    message: "Cannot read or write protected channel settings.",
  });

const directoryFor = (dataDirectory: string, adapter: string, create: boolean) =>
  Effect.tryPromise({
    try: async () => {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(adapter)) throw new Error("Invalid channel ID");
      const directory = join(dataDirectory, "channels");

      if (create) await mkdir(directory, { recursive: true, mode: 0o700 });

      const info = await lstat(directory).catch((cause: unknown) => {
        if (Schema.is(MissingFile)(cause)) return null;
        throw cause;
      });

      if (info === null) return null;

      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
        throw new Error("Invalid channel directory");
      await chmod(directory, 0o700);

      return directory;
    },
    catch: settingsError,
  });

/** Reads bounded protected text; each adapter decodes its own settings schema. */
export const loadChannelSettings = (dataDirectory: string, adapter: string) =>
  Effect.gen(function* () {
    const directory = yield* directoryFor(dataDirectory, adapter, false);

    if (directory === null) return null;

    return yield* Effect.tryPromise({
      try: async () => {
        const handle = await open(
          join(directory, `${adapter}.json`),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        ).catch((cause: unknown) => {
          if (Schema.is(MissingFile)(cause)) return null;
          throw cause;
        });

        if (handle === null) return null;

        try {
          const info = await handle.stat();

          if (
            !info.isFile() ||
            info.nlink !== 1 ||
            info.uid !== process.getuid?.() ||
            info.size > 16384
          )
            throw new Error("Invalid channel file");
          await handle.chmod(0o600);

          return await handle.readFile("utf8");
        } finally {
          await handle.close();
        }
      },
      catch: settingsError,
    });
  });

/** Atomically replaces one adapter file under its existing owner lock. */
export const saveChannelSettings = (dataDirectory: string, adapter: string, contents: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (Buffer.byteLength(contents) > 16384) return yield* Effect.fail(settingsError());
      const directory = yield* directoryFor(dataDirectory, adapter, true);

      if (directory === null) return yield* Effect.fail(settingsError());
      yield* acquireOwnerLock(join(directory, `${adapter}.lock`)).pipe(
        Effect.mapError(settingsError),
      );
      yield* Effect.tryPromise({
        try: async () => {
          const temporary = join(directory, `.${adapter}-${randomUUID()}.tmp`);
          const handle = await open(temporary, "wx", 0o600);

          try {
            await handle.writeFile(contents, "utf8");
            await handle.sync();
            await handle.close();
            await rename(temporary, join(directory, `${adapter}.json`));
          } finally {
            await handle.close().catch(() => undefined);
            await unlink(temporary).catch(() => undefined);
          }
        },
        catch: settingsError,
      });
    }),
  ).pipe(Effect.uninterruptible);

/** Protected settings for one adapter, decoded strictly from its saved JSON text. */
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
    /** Loads settings now and defers the adapter import until the layer is built. */
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
