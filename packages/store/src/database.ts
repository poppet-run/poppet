import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";

import { AppConfig } from "@poppet/config";
import { Context, Effect, Layer, Schema } from "effect";

import { StoreError, storageFailure } from "#src/errors";
import { applyMigrations } from "#src/migrations";

export class StoreDatabase extends Context.Service<
  StoreDatabase,
  { readonly database: Database; readonly path: string; readonly schemaVersion: number }
>()("poppet/StoreDatabase") {}

const MissingFile = Schema.Struct({ code: Schema.Literal("ENOENT") });

export const StoreDatabaseLive = Layer.effect(
  StoreDatabase,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const directory = join(config.dataDirectory, "store");
    const path = join(directory, "poppet.sqlite");
    const lockPath = join(directory, "owner.lock");

    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const info = await lstat(directory);

        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("Invalid store directory");
        await chmod(directory, 0o700);
      },
      catch: storageFailure,
    });

    // Acquire ownership before SQLite opens, migrates, or recovers unfinished work.
    // Database finalization runs before this lock is released.
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const handle = await open(lockPath, "wx", 0o600);

          try {
            await handle.writeFile(JSON.stringify({ pid: process.pid }));

            return handle;
          } catch (cause) {
            await handle.close();
            await unlink(lockPath);
            throw cause;
          }
        },
        catch: () =>
          new StoreError({
            reason: "busy",
            message: `Another Poppet store may be open. If no Poppet process owns this database, remove ${lockPath} and retry.`,
          }),
      }),
      (handle) =>
        Effect.promise(async () => {
          await handle.close();
          await unlink(lockPath);
        }),
    );

    yield* Effect.tryPromise({
      try: async () => {
        await Promise.all(
          [path, `${path}-wal`, `${path}-shm`].map(async (candidate) => {
            const info = await lstat(candidate).catch((cause: unknown) => {
              if (Schema.is(MissingFile)(cause)) return null;
              throw cause;
            });

            if (info && (!info.isFile() || info.isSymbolicLink()))
              throw new Error("Invalid database file");
          }),
        );

        const handle = await open(
          path,
          constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
          0o600,
        );

        try {
          if (!(await handle.stat()).isFile()) throw new Error("Invalid database file");
          await handle.chmod(0o600);
        } finally {
          await handle.close();
        }
      },
      catch: storageFailure,
    });

    const database = yield* Effect.acquireRelease(
      Effect.try({
        try: () => new Database(path, { strict: true, create: true }),
        catch: storageFailure,
      }),
      (owned) => Effect.sync(() => owned.close(true)),
    );

    const schemaVersion = yield* Effect.try({
      try: () => {
        database.run("PRAGMA foreign_keys = ON");
        database.run("PRAGMA journal_mode = WAL");
        database.run("PRAGMA synchronous = FULL");

        return applyMigrations(database);
      },
      catch: storageFailure,
    });

    // Sidecars can survive closing on macOS; protect them as well as the main file.
    yield* Effect.tryPromise({
      try: async () => {
        await Promise.all(
          [`${path}-wal`, `${path}-shm`].map((candidate) =>
            chmod(candidate, 0o600).catch((cause: unknown) => {
              if (!Schema.is(MissingFile)(cause)) throw cause;
            }),
          ),
        );
      },
      catch: storageFailure,
    });

    return { database, path, schemaVersion };
  }),
);
