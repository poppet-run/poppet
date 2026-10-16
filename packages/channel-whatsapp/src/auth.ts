import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import { acquireOwnerLock } from "@poppet/credentials/lock";
import { ChannelError } from "@poppet/gateway";
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "baileys";
import { Effect, Schema } from "effect";

const Bytes = Schema.instanceOf(Uint8Array);

const KeyPair = Schema.Struct({ public: Bytes, private: Bytes });

const Creds = Schema.Struct({
  noiseKey: KeyPair,
  pairingEphemeralKeyPair: KeyPair,
  signedIdentityKey: KeyPair,
  signedPreKey: Schema.Struct({ keyPair: KeyPair, signature: Bytes, keyId: Schema.Natural }),
  registrationId: Schema.Natural,
  advSecretKey: Schema.NonEmptyString,
  firstUnuploadedPreKeyId: Schema.Natural,
  nextPreKeyId: Schema.Natural,
  accountSyncCounter: Schema.Natural,
  accountSettings: Schema.Struct({ unarchiveChats: Schema.Boolean }),
  registered: Schema.Boolean,
  me: Schema.optionalKey(Schema.Struct({ id: Schema.NonEmptyString })),
  pairingCode: Schema.optionalKey(Schema.String),
  lastPropHash: Schema.optionalKey(Schema.String),
  routingInfo: Schema.optionalKey(Schema.instanceOf(Buffer)),
  processedHistoryMessages: Schema.Array(Schema.Struct({ key: Schema.Struct({}) })),
});

const MissingFile = Schema.Struct({ code: Schema.Literal("ENOENT") });

const failure = () =>
  new ChannelError({
    reason: "configuration",
    message:
      "Cannot read or persist protected WhatsApp authentication. Stop the worker and inspect the channel's local storage.",
  });

const deserializeCreds = (text: string): AuthenticationCreds => {
  const saved: unknown = JSON.parse(text, BufferJSON.reviver);
  Schema.decodeUnknownSync(Creds)(saved);

  // SAFETY: Validate required SDK fields without stripping its optional protocol data from the parsed state.
  return saved as AuthenticationCreds;
};

/** Owns Signal keys separately from transcripts; every key batch commits atomically. */
export const openWhatsAppAuth = (dataDirectory: string, onFailure: () => void) =>
  Effect.gen(function* () {
    const directory = join(dataDirectory, "channels");
    const path = join(directory, "whatsapp-auth.sqlite");
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const info = await lstat(directory);

        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
          throw failure();
        await chmod(directory, 0o700);
      },
      catch: failure,
    });
    yield* acquireOwnerLock(join(directory, "whatsapp-auth.lock")).pipe(
      Effect.mapError(
        () =>
          new ChannelError({
            reason: "configuration",
            message:
              "WhatsApp authentication is busy or inaccessible. Stop the worker before pairing.",
          }),
      ),
    );

    const database = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          for (const suffix of ["", "-journal", "-wal", "-shm"]) {
            // eslint-disable-next-line no-await-in-loop -- Validate each SQLite sidecar before opening the database.
            const info = await lstat(`${path}${suffix}`).catch((cause: unknown) => {
              if (Schema.is(MissingFile)(cause)) return null;
              throw cause;
            });

            if (
              info &&
              (!info.isFile() ||
                info.isSymbolicLink() ||
                info.nlink !== 1 ||
                info.uid !== process.getuid?.())
            )
              throw failure();
          }

          const handle = await open(
            path,
            constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
            0o600,
          );

          try {
            await handle.chmod(0o600);
          } finally {
            await handle.close();
          }

          return new Database(path);
        },
        catch: failure,
      }),
      (owned) => Effect.sync(() => owned.close()),
    );

    yield* Effect.try({
      try: () => {
        const version = Schema.decodeUnknownSync(Schema.Struct({ user_version: Schema.Natural }))(
          database.query("PRAGMA user_version").get(),
        ).user_version;

        const identity = Schema.decodeUnknownSync(
          Schema.Struct({ application_id: Schema.Natural }),
        )(database.query("PRAGMA application_id").get()).application_id;

        const tables = database
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all();

        if (version === 0 && identity === 0 && tables.length === 0)
          database
            .transaction(() => {
              database.run(
                "CREATE TABLE auth (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (kind, id)) STRICT",
              );
              database.run("CREATE TABLE outgoing (id TEXT PRIMARY KEY) STRICT");
              database.run("PRAGMA application_id = 1347895637");
              database.run("PRAGMA user_version = 1");
            })
            .immediate();
        else if (version !== 1 || identity !== 1347895637) throw failure();
      },
      catch: failure,
    });

    let failed = false;

    const operation = <A>(work: () => A): A => {
      if (failed) throw failure();

      try {
        return work();
      } catch {
        failed = true;
        onFailure();
        throw failure();
      }
    };

    const read = (kind: string, id: string) =>
      Schema.decodeUnknownSync(Schema.NullOr(Schema.Struct({ payload: Schema.String })))(
        database.query("SELECT payload FROM auth WHERE kind = ? AND id = ?").get(kind, id),
      )?.payload;

    const write = (kind: string, id: string, value: string) =>
      database
        .query(
          "INSERT INTO auth VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET payload = excluded.payload",
        )
        .run(kind, id, value);

    const saved = yield* Effect.try({ try: () => read("creds", "current"), catch: failure });

    const creds = yield* Effect.try({
      try: () => (saved === undefined ? initAuthCreds() : deserializeCreds(saved)),
      catch: failure,
    });

    const state: AuthenticationState = {
      creds,
      keys: {
        get: (type, ids) =>
          operation(() => {
            const result: { [id: string]: SignalDataTypeMap[typeof type] } = {};

            for (const id of ids) {
              const text = read(type, id);

              if (text === undefined) continue;
              const value = JSON.parse(text, BufferJSON.reviver);
              // SAFETY: These type-keyed values are written only by this pinned SDK; its codec restores binary fields.
              result[id] = (
                type === "app-state-sync-key"
                  ? proto.Message.AppStateSyncKeyData.fromObject(value)
                  : value
              ) as SignalDataTypeMap[typeof type];
            }

            return result;
          }),
        set: (data) =>
          operation(() =>
            database
              .transaction(() => {
                for (const [kind, values] of Object.entries(data)) {
                  for (const [id, value] of Object.entries(values)) {
                    if (value === null)
                      database.query("DELETE FROM auth WHERE kind = ? AND id = ?").run(kind, id);
                    else write(kind, id, JSON.stringify(value, BufferJSON.replacer));
                  }
                }
              })
              .immediate(),
          ),
      },
    };

    const saveCreds = (update: Partial<AuthenticationCreds>) =>
      operation(() => {
        Object.assign(state.creds, update);
        const text = JSON.stringify(state.creds, BufferJSON.replacer);
        deserializeCreds(text);
        write("creds", "current", text);
      });

    if (saved === undefined) yield* Effect.try({ try: () => saveCreds({}), catch: failure });

    return {
      state,
      saveCreds,
      failed: () => failed,
      reset: () =>
        operation(() =>
          database
            .transaction(() => {
              database.run("DELETE FROM auth");
              const fresh = initAuthCreds();
              write("creds", "current", JSON.stringify(fresh, BufferJSON.replacer));
              state.creds = fresh;
            })
            .immediate(),
        ),
      rememberOutgoing: (id: string) =>
        operation(() => {
          database.query("INSERT INTO outgoing VALUES (?) ON CONFLICT DO NOTHING").run(id);
        }),
      isOutgoing: (id: string) =>
        operation(() => database.query("SELECT id FROM outgoing WHERE id = ?").get(id) !== null),
    };
  });

export type WhatsAppAuth = Effect.Success<ReturnType<typeof openWhatsAppAuth>>;
