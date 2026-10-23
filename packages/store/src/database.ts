import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { AppConfig } from "@poppet/config";
import { acquireOwnerLock } from "@poppet/credentials/lock";
import { Context, Effect, Layer, Schema, String as Str } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";

import { StoreError, storageFailure } from "#src/errors";
import { migrations, schemaVersion } from "#src/migrations";
import { decodeRow } from "#src/sql";

/** Where the shared database lives. Query it through `SqlClient`, which this layer also provides. */
export class StoreDatabase extends Context.Service<StoreDatabase, { readonly path: string }>()(
  "poppet/StoreDatabase",
) {}

const MissingFile = Schema.Struct({ code: Schema.Literal("ENOENT") });

const migrationFailure = (message: string) => new StoreError({ reason: "migration", message });

// The store only migrates databases it created. Anything else is left untouched.
const checkHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const ledger = yield* sql`SELECT name FROM sqlite_master WHERE name = 'effect_sql_migrations'`;

  if (ledger.length === 0) {
    const tables = yield* sql`SELECT name FROM sqlite_master WHERE type = 'table'`;

    if (tables.length > 0)
      return yield* migrationFailure(
        "The conversation database was not created by this version of Poppet. Move it aside to start a new store.",
      );

    return;
  }

  const latest = yield* sql`SELECT MAX(migration_id) AS latest FROM effect_sql_migrations`.pipe(
    decodeRow(Schema.Struct({ latest: Schema.NullOr(Schema.Int) })),
  );

  if ((latest?.latest ?? 0) > schemaVersion)
    return yield* migrationFailure(
      "The conversation database was created by a newer version of Poppet. Upgrade Poppet to open it.",
    );
});

/** Protects, opens, and migrates local storage; closes the connection before its owner lock. */
export const StoreDatabaseLive = Layer.effectContext(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const directory = join(config.dataDirectory, "store");
    const path = join(directory, "poppet.sqlite");

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
    // Scope finalizers run in reverse, so the connection closes before this lock is released.
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

    // Refuse symlinks and create the file owner-only before SQLite opens it.
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

    // Rows use camelCase names, and insert helpers write snake_case columns.
    const client = yield* SqliteClient.make({
      filename: path,
      transformResultNames: Str.snakeToCamel,
      transformQueryNames: Str.camelToSnake,
    }).pipe(Effect.provide(Reactivity.layer), Effect.mapError(storageFailure));

    // One connection serves every query, so these settings hold for its lifetime.
    yield* Effect.all([client`PRAGMA foreign_keys = ON`, client`PRAGMA synchronous = FULL`]).pipe(
      Effect.mapError(storageFailure),
    );

    yield* checkHistory.pipe(
      Effect.andThen(SqliteMigrator.run({ loader: migrations })),
      Effect.provideService(SqlClient.SqlClient, client),
      // A failed migration is reported as a defect after its transaction rolls back.
      Effect.catchDefect((defect) => Effect.fail(defect)),
      Effect.mapError((error) =>
        error instanceof StoreError
          ? error
          : migrationFailure(
              "Conversation database migration failed. No pending migrations were committed.",
            ),
      ),
    );

    // Sidecars can survive closing on macOS; protect them as well as the main file.
    yield* Effect.tryPromise({
      try: () =>
        Promise.all(
          [`${path}-wal`, `${path}-shm`].map((candidate) =>
            chmod(candidate, 0o600).catch((cause: unknown) => {
              if (!Schema.is(MissingFile)(cause)) throw cause;
            }),
          ),
        ),
      catch: storageFailure,
    });

    return Context.make(StoreDatabase, { path }).pipe(Context.add(SqlClient.SqlClient, client));
  }),
);
