import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";

import { openNoFollow, writeFileAtomic } from "@poppet/io";
import { Data, Effect, Schema } from "effect";

/** Reports an existing storage owner or a failure to protect the ownership files. */
export class OwnerLockError extends Data.TaggedError("OwnerLockError")<{
  readonly reason: "busy" | "storage";
  readonly message: string;
}> {}

const BusyDatabase = Schema.Struct({ code: Schema.Literal("SQLITE_BUSY") });

// SQLite keeps an exclusive lock until close, and the OS releases it after a crash.
// The PID marker only records the current owner for diagnostics.
export const acquireOwnerLock = (path: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const handle = await open(
          `${path}.sqlite`,
          constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
          0o600,
        );

        try {
          if (!(await handle.stat()).isFile()) throw new Error("Invalid lock file");
          await handle.chmod(0o600);
        } finally {
          await handle.close();
        }

        const database = new Database(`${path}.sqlite`);

        try {
          database.run("PRAGMA locking_mode = EXCLUSIVE");
          database.run("BEGIN EXCLUSIVE");
          database.run("COMMIT");

          // The exclusive SQLite lock proves no current owner is running. A marker left by a
          // crashed owner is replaced even if its PID now belongs to an unrelated process.
          const previous = await openNoFollow(path);

          if (previous !== null) {
            try {
              const info = await previous.stat();

              if (!info.isFile() || info.size > 512) throw new Error("Invalid owner marker");
            } finally {
              await previous.close();
            }
          }

          // Replace the marker atomically, so a crash cannot leave an empty PID file.
          await writeFileAtomic(path, JSON.stringify({ pid: process.pid }));

          return database;
        } catch (cause) {
          database.close();
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
    (database) =>
      Effect.promise(async () => {
        try {
          await unlink(path);
        } finally {
          database.close();
        }
      }),
  ).pipe(Effect.asVoid);
