import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { acquireOwnerLock } from "@poppet/credentials/lock";
import { isMissingFile, readProtectedFile, writeFileAtomic } from "@poppet/io";
import { ProviderEnvironment } from "@poppet/provider";
import { Context, Effect, Layer, Schema } from "effect";

import { Connection, ConnectionError } from "#src/connection";

interface StoreOperations {
  /** Returns null without creating identity when no connection file exists. */
  readonly read: Effect.Effect<Connection | null, ConnectionError>;
  /** Reuses a saved connection or creates a host identity for a new login. */
  readonly initialize: Effect.Effect<Connection, ConnectionError>;
  /** Deletes the entire saved connection, including identity, registration, and verification. */
  readonly remove: Effect.Effect<void, ConnectionError>;
  /** Atomically replaces the protected connection file, deferring cancellation until cleanup. */
  readonly write: (connection: Connection) => Effect.Effect<void, ConnectionError>;
}

/** Protected ChatGPT connection storage held by one owner for the service's scope. */
export class CredentialStore extends Context.Service<CredentialStore, StoreOperations>()(
  "poppet/CredentialStore",
) {}

const ConnectionJson = Schema.fromJsonString(Connection);

const storageError = () =>
  new ConnectionError({
    reason: "storage",
    message: "Cannot read or write Poppet's protected authentication storage.",
  });

export const CredentialStoreLive = Layer.effect(
  CredentialStore,
  Effect.gen(function* () {
    const config = yield* ProviderEnvironment;
    const directory = join(config.dataDirectory, "auth");
    const path = join(directory, "connection.json");
    const lockPath = join(directory, "owner.lock");

    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const info = await lstat(directory);

        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("Authentication directory must be a real directory.");
        await chmod(directory, 0o700);
      },
      catch: storageError,
    });

    yield* acquireOwnerLock(lockPath).pipe(
      Effect.mapError((error) =>
        error.reason === "busy"
          ? new ConnectionError({
              reason: "busy",
              code: "credential_store_busy",
              message:
                "Another Poppet authentication command is active. Wait for it to finish, then try again.",
            })
          : storageError(),
      ),
    );

    // Write and sync a separate file, then rename it over the saved connection
    // so readers never see partial JSON. Cancellation waits for this write or
    // its cleanup to finish because the whole operation is uninterruptible.
    const write = (connection: Connection) =>
      Effect.tryPromise({
        try: () => writeFileAtomic(path, Schema.encodeSync(ConnectionJson)(connection)),
        catch: storageError,
      }).pipe(Effect.uninterruptible);

    const read = Effect.gen(function* () {
      const contents = yield* Effect.tryPromise({
        try: () => readProtectedFile(path, { makePrivate: true }),
        catch: storageError,
      });

      if (contents === null) return null;

      return yield* Schema.decodeUnknownEffect(ConnectionJson)(contents).pipe(
        Effect.mapError(storageError),
      );
    });

    const initialize = Effect.gen(function* () {
      const saved = yield* read;

      if (saved !== null) return saved;

      // Only a login creates provider identity. Status and logout stay read-only
      // when no connection has been saved.
      const connection: Connection = {
        version: 1,
        hostId: `urn:uuid:${randomUUID()}`,
        clientId: null,
        identity: null,
        credentials: null,
        verification: null,
      };

      yield* write(connection);

      return connection;
    });

    const remove = Effect.tryPromise({
      try: () =>
        unlink(path).catch((cause: unknown) => {
          if (!isMissingFile(cause)) throw cause;
        }),
      catch: storageError,
    }).pipe(Effect.uninterruptible);

    return { read, initialize, write, remove } satisfies StoreOperations;
  }),
);
