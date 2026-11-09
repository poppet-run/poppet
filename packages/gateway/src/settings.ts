import { join } from "node:path";

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

/** Reads bounded protected text; each adapter decodes its own settings schema. */
export const loadChannelSettings = (dataDirectory: string, adapter: string) =>
  filesFor(dataDirectory, adapter).pipe(Effect.flatMap((files) => files.read(adapter)));

/** Atomically replaces one adapter file under its existing owner lock. */
export const saveChannelSettings = (dataDirectory: string, adapter: string, contents: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (Buffer.byteLength(contents) > 16384) return yield* Effect.fail(settingsError());
      const files = yield* filesFor(dataDirectory, adapter);

      yield* files.lock(adapter).pipe(Effect.mapError(settingsError));
      yield* files.write(adapter, contents);
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
