import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";

import { openNoFollow, writeFileAtomic } from "@poppet/io";
import { Data, Effect, Schema } from "effect";

export class OwnerLockError extends Data.TaggedError("OwnerLockError")<{
  readonly reason: "busy" | "storage";
  readonly message: string;
}> {}

const BusyDatabase = Schema.Struct({ code: Schema.Literal("SQLITE_BUSY") });

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

          const previous = await openNoFollow(path);

          if (previous !== null) {
            try {
              const info = await previous.stat();

              if (!info.isFile() || info.size > 512) throw new Error("Invalid owner marker");
            } finally {
              await previous.close();
            }
          }

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
