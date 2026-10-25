import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { acquireOwnerLock } from "@poppet/credentials/lock";
import {
  ensurePrivateDirectory,
  readProtectedFile,
  unlinkIfPresent,
  writeFileAtomic,
} from "@poppet/io";
import { ProviderEnvironment } from "@poppet/provider";
import { Context, Effect, Layer, RcMap, Schema, Scope, Semaphore } from "effect";

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
  /** Runs an effect while no other user of this store in the process holds the permit. */
  readonly withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** Protected ChatGPT connection storage owned by this process while any service scope is open. */
export class CredentialStore extends Context.Service<CredentialStore, StoreOperations>()(
  "poppet/CredentialStore",
) {}

const ConnectionJson = Schema.fromJsonString(Connection);

const storageError = () =>
  new ConnectionError({
    reason: "storage",
    message: "Cannot read or write Poppet's protected authentication storage.",
  });

// Concurrent model requests each build this layer. Builds in one process share
// the owner lock and one permit per lock path, so a token refresh runs once
// while other processes stay out until the last build here closes.
const owners = Effect.runSync(
  RcMap.make({
    lookup: (lockPath: string) =>
      acquireOwnerLock(lockPath).pipe(Effect.andThen(Semaphore.make(1))),
  }).pipe(Effect.provideService(Scope.Scope, Scope.makeUnsafe())),
);

export const CredentialStoreLive = Layer.effect(
  CredentialStore,
  Effect.gen(function* () {
    const config = yield* ProviderEnvironment;
    const directory = join(config.dataDirectory, "auth");
    const path = join(directory, "connection.json");
    const lockPath = join(directory, "owner.lock");

    yield* Effect.tryPromise({
      try: () => ensurePrivateDirectory(directory),
      catch: storageError,
    });

    const permit = yield* RcMap.get(owners, lockPath).pipe(
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
      try: () => unlinkIfPresent(path),
      catch: storageError,
    }).pipe(Effect.uninterruptible);

    return {
      read,
      initialize,
      write,
      remove,
      withPermit: permit.withPermit,
    } satisfies StoreOperations;
  }),
);
