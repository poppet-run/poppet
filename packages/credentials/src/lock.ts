import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";

import { Data, Effect, Option, Schema } from "effect";

/** Reports an existing storage owner or a failure to protect the ownership files. */
export class OwnerLockError extends Data.TaggedError("OwnerLockError")<{
  readonly reason: "busy" | "storage";
  readonly message: string;
}> {}

const MissingFile = Schema.Struct({ code: Schema.Literal("ENOENT") });

const MissingProcess = Schema.Struct({ code: Schema.Literal("ESRCH") });

const BusyDatabase = Schema.Struct({ code: Schema.Literal("SQLITE_BUSY") });

const Owner = Schema.fromJsonString(
  Schema.Struct({ pid: Schema.Int.check(Schema.isGreaterThan(0)) }),
);

// SQLite keeps an exclusive lock until close, and the OS releases it after a crash.
// The PID marker also prevents taking storage from an older, file-lock-only owner.
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

          const previous = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          ).catch((cause: unknown) => {
            if (Schema.is(MissingFile)(cause)) return null;
            throw cause;
          });

          let saved: string | null = null;

          if (previous !== null) {
            try {
              const info = await previous.stat();

              if (!info.isFile() || info.size > 512) throw new Error("Invalid owner marker");
              saved = await previous.readFile("utf8");
            } finally {
              await previous.close();
            }
          }

          if (saved !== null) {
            const owner = Schema.decodeUnknownOption(Owner)(saved);
            const pid = Option.isSome(owner) ? owner.value.pid : null;
            let alive = true;

            if (pid !== null) {
              try {
                process.kill(pid, 0);
              } catch (cause) {
                if (Schema.is(MissingProcess)(cause)) alive = false;
                else throw cause;
              }
            }

            if (alive)
              throw new OwnerLockError({ reason: "busy", message: "Another owner may be active." });
          }

          // Replace the marker atomically, so a crash cannot leave an empty PID file.
          const temporary = `${path}.${randomUUID()}.tmp`;
          const marker = await open(temporary, "wx", 0o600);

          try {
            await marker.writeFile(JSON.stringify({ pid: process.pid }));
            await marker.sync();
            await marker.close();
            await rename(temporary, path);
          } catch (cause) {
            await marker.close().catch(() => undefined);
            await unlink(temporary).catch(() => undefined);
            throw cause;
          }

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
