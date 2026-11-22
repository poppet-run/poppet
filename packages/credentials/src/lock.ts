import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { openNoFollow, unlinkIfPresent, writeFileAtomic } from "@poppet/io";
import { Data, Effect, Schema } from "effect";

export class OwnerLockError extends Data.TaggedError("OwnerLockError")<{
  readonly reason: "busy" | "storage";
  readonly message: string;
}> {}

const BusyDatabase = Schema.Struct({ code: Schema.Literal("SQLITE_BUSY") });
const activeLocks = new Set<string>();

const canonicalLockKey = async (lockPath: string) => {
  const directory = dirname(lockPath);
  const canonicalDirectory = await realpath(directory).catch(() => directory);

  return join(canonicalDirectory, basename(lockPath));
};

export const acquireOwnerLock = (path: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const lockPath = resolve(path);
        const key = await canonicalLockKey(lockPath);

        if (activeLocks.has(key))
          throw new OwnerLockError({
            reason: "busy",
            message: "Could not acquire protected storage ownership.",
          });

        activeLocks.add(key);

        let database: Database | undefined;

        try {
          const handle = await open(
            `${lockPath}.sqlite`,
            constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
            0o600,
          );

          try {
            if (!(await handle.stat()).isFile()) throw new Error("Invalid lock file");
            await handle.chmod(0o600);
          } finally {
            await handle.close();
          }

          database = new Database(`${lockPath}.sqlite`);
          database.run("PRAGMA locking_mode = EXCLUSIVE");
          database.run("BEGIN EXCLUSIVE");
          database.run("COMMIT");

          const previous = await openNoFollow(lockPath);

          if (previous !== null) {
            try {
              const info = await previous.stat();

              if (!info.isFile() || info.size > 512) throw new Error("Invalid owner marker");
            } finally {
              await previous.close();
            }
          }

          await writeFileAtomic(lockPath, JSON.stringify({ pid: process.pid }));

          return { database, key, lockPath };
        } catch (cause) {
          database?.close();
          activeLocks.delete(key);
          throw cause;
        }
      },
      catch: (cause) =>
        cause instanceof OwnerLockError
          ? cause
          : new OwnerLockError({
              reason: Schema.is(BusyDatabase)(cause) ? "busy" : "storage",
              message: "Could not acquire protected storage ownership.",
            }),
    }),
    ({ database, key, lockPath }) =>
      Effect.promise(async () => {
        try {
          await unlinkIfPresent(lockPath);
        } finally {
          try {
            database.close();
          } finally {
            activeLocks.delete(key);
          }
        }
      }),
  ).pipe(Effect.asVoid);
