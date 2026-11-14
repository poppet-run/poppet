import { constants } from "node:fs";
import { chmod, lstat, open } from "node:fs/promises";
import { join } from "node:path";

import { SqliteClient } from "@effect/sql-sqlite-bun";
import { AppConfig } from "@poppet/config";
import { acquireOwnerLock } from "@poppet/credentials/lock";
import { ensurePrivateDirectory, isMissingFile } from "@poppet/io";
import { Context, Effect, Layer, String as Str } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";

import { StoreError, storageFailure } from "#src/errors";
import { migrate, storeSchema } from "#src/migrations";

export class StoreDatabase extends Context.Service<StoreDatabase, { readonly path: string }>()(
  "poppet/StoreDatabase",
) {}

const checkOrigin = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const ledger = yield* sql`SELECT name FROM sqlite_master WHERE name = ${storeSchema.table}`;
  const tables = yield* sql`SELECT name FROM sqlite_master WHERE type = 'table'`;

  if (ledger.length === 0 && tables.length > 0)
    return yield* new StoreError({
      reason: "migration",
      message:
        "The conversation database was not created by this version of Poppet. Move it aside to start a new store.",
    });
});

export const StoreDatabaseLive = Layer.effectContext(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const directory = join(config.dataDirectory, "store");
    const path = join(directory, "poppet.sqlite");

    yield* Effect.tryPromise({
      try: () => ensurePrivateDirectory(directory),
      catch: storageFailure,
    });

    yield* acquireOwnerLock(join(directory, "owner.lock")).pipe(
      Effect.mapError((error) =>
        error.reason === "busy"
          ? new StoreError({
              reason: "busy",
              message:
                "Another Poppet process has the store open. Stop it, or run the command while the worker is running so it can serve the request.",
            })
          : storageFailure(error),
      ),
    );

    yield* Effect.tryPromise({
      try: async () => {
        await Promise.all(
          [path, `${path}-wal`, `${path}-shm`].map(async (candidate) => {
            const info = await lstat(candidate).catch((cause: unknown) => {
              if (isMissingFile(cause)) return null;
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

    const client = yield* SqliteClient.make({
      filename: path,
      transformResultNames: Str.snakeToCamel,
      transformQueryNames: Str.camelToSnake,
    }).pipe(Effect.provide(Reactivity.layer), Effect.mapError(storageFailure));

    yield* Effect.all([client`PRAGMA foreign_keys = ON`, client`PRAGMA synchronous = FULL`]).pipe(
      Effect.mapError(storageFailure),
    );

    yield* checkOrigin.pipe(
      Effect.andThen(migrate(storeSchema)),
      Effect.provideService(SqlClient.SqlClient, client),
      Effect.mapError(storageFailure),
    );

    yield* Effect.tryPromise({
      try: () =>
        Promise.all(
          [`${path}-wal`, `${path}-shm`].map((candidate) =>
            chmod(candidate, 0o600).catch((cause: unknown) => {
              if (!isMissingFile(cause)) throw cause;
            }),
          ),
        ),
      catch: storageFailure,
    });

    return Context.make(StoreDatabase, { path }).pipe(Context.add(SqlClient.SqlClient, client));
  }),
);
