import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { acquireOwnerLock } from "@poppet/credentials/lock";
import { ChannelError } from "@poppet/gateway";
import { Effect, Schema } from "effect";

/** A Discord snowflake kept as text to preserve integer precision. */
export const DiscordId = Schema.String.check(Schema.isPattern(/^\d{1,20}$/));

/** Protected bot credentials and the explicit owner, guild, and channels allowed to use them. */
export const DiscordSettings = Schema.Struct({
  version: Schema.Literal(1),
  botId: DiscordId,
  ownerId: DiscordId,
  guildId: DiscordId,
  channelIds: Schema.Array(DiscordId).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  token: Schema.RedactedFromValue(Schema.String.check(Schema.isPattern(/^\S{1,8192}$/))),
});

export type DiscordSettings = typeof DiscordSettings.Type;

const MissingFile = Schema.Struct({ code: Schema.Literal("ENOENT") });

const SavedSettings = Schema.fromJsonString(DiscordSettings);

const settingsError = () =>
  new ChannelError({
    reason: "configuration",
    message: "Cannot read or write protected Discord settings. Run gateway discord setup again.",
  });

const directoryFor = (dataDirectory: string, create: boolean) =>
  Effect.tryPromise({
    try: async () => {
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

export const loadDiscordSettings = (dataDirectory: string) =>
  Effect.gen(function* () {
    const directory = yield* directoryFor(dataDirectory, false);

    if (directory === null) return null;

    const contents = yield* Effect.tryPromise({
      try: async () => {
        const handle = await open(
          join(directory, "discord.json"),
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

    if (contents === null) return null;

    return yield* Schema.decodeUnknownEffect(SavedSettings, { onExcessProperty: "error" })(
      contents,
    ).pipe(Effect.mapError(settingsError));
  });

export const saveDiscordSettings = (dataDirectory: string, settings: DiscordSettings) =>
  Effect.scoped(
    Effect.gen(function* () {
      const contents = yield* Schema.encodeEffect(SavedSettings)(settings).pipe(
        Effect.mapError(settingsError),
      );

      const directory = yield* directoryFor(dataDirectory, true);

      if (directory === null) return yield* Effect.fail(settingsError());
      yield* acquireOwnerLock(join(directory, "discord.lock")).pipe(Effect.mapError(settingsError));
      yield* Effect.tryPromise({
        try: async () => {
          const temporary = join(directory, `.discord-${randomUUID()}.tmp`);
          const handle = await open(temporary, "wx", 0o600);

          try {
            await handle.writeFile(contents, "utf8");
            await handle.sync();
            await handle.close();
            await rename(temporary, join(directory, "discord.json"));
          } finally {
            await handle.close().catch(() => undefined);
            await unlink(temporary).catch(() => undefined);
          }
        },
        catch: settingsError,
      });
    }),
  ).pipe(Effect.uninterruptible);
