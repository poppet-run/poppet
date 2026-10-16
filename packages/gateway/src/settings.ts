import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { acquireOwnerLock } from "@poppet/credentials/lock";
import { Effect, Schema } from "effect";

import { ChannelError } from "#src/channel";

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

    const contents = yield* Effect.tryPromise({
      try: async () => {
        const handle = await open(
          join(directory, `${adapter}.json`),
          constants.O_RDONLY | constants.O_NOFOLLOW,
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

    return contents;
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
