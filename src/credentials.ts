import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { Context, Effect, Layer, Schema } from "effect";

import { AppConfig } from "./config.ts";
import { Connection, ConnectionError } from "./connection.ts";

interface StoreOperations {
  readonly read: Effect.Effect<Connection, ConnectionError>;
  readonly write: (connection: Connection) => Effect.Effect<void, ConnectionError>;
}

export class CredentialStore extends Context.Service<CredentialStore, StoreOperations>()(
  "poppet/CredentialStore",
) {}

const ConnectionJson = Schema.fromJsonString(Connection);

const MissingFile = Schema.Struct({ code: Schema.Literal("ENOENT") });

const storageError = () =>
  new ConnectionError({
    reason: "storage",
    message: "Cannot read or write Poppet's protected authentication storage.",
  });

export const CredentialStoreLive = Layer.effect(
  CredentialStore,
  Effect.gen(function* () {
    const config = yield* AppConfig;
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

    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => open(lockPath, "wx", 0o600),
        catch: () =>
          new ConnectionError({
            reason: "busy",
            message: `Another Poppet authentication command may be active. If no command is running, remove ${lockPath} and retry.`,
          }),
      }),
      (handle) =>
        Effect.promise(async () => {
          await handle.close();
          await unlink(lockPath);
        }),
    );

    const write = (connection: Connection) =>
      Effect.tryPromise({
        try: async () => {
          const temporaryPath = join(directory, `.connection-${randomUUID()}.tmp`);
          const contents = Schema.encodeSync(ConnectionJson)(connection);
          const handle = await open(temporaryPath, "wx", 0o600);

          try {
            await handle.writeFile(contents, "utf8");
            await handle.sync();
            await handle.close();
            await rename(temporaryPath, path);
          } catch (cause) {
            await handle.close().catch(() => undefined);
            await unlink(temporaryPath).catch(() => undefined);
            throw cause;
          }
        },
        catch: storageError,
      }).pipe(Effect.uninterruptible);

    const read = Effect.gen(function* () {
      const info = yield* Effect.tryPromise({
        try: () =>
          lstat(path).catch((cause: unknown) => {
            if (Schema.is(MissingFile)(cause)) return null;
            throw cause;
          }),
        catch: storageError,
      });

      if (info === null) {
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
      }

      const contents = yield* Effect.tryPromise({
        try: async () => {
          if (!info.isFile() || info.isSymbolicLink())
            throw new Error("Credentials must be a regular file.");
          await chmod(path, 0o600);

          return Bun.file(path).text();
        },
        catch: storageError,
      });

      return yield* Schema.decodeUnknownEffect(ConnectionJson)(contents).pipe(
        Effect.mapError(storageError),
      );
    });

    return { read, write } satisfies StoreOperations;
  }),
);
