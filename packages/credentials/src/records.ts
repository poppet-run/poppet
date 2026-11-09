import { join } from "node:path";

import {
  ensurePrivateDirectory,
  readProtectedFile,
  unlinkIfPresent,
  writeFileAtomic,
} from "@poppet/io";
import { Data, Effect, Schedule, Schema } from "effect";

import { acquireOwnerLock, OwnerLockError } from "#src/lock";

/** A protected record could not be read, locked, or replaced. */
export class RecordStoreError extends Data.TaggedError("RecordStoreError")<{
  readonly message: string;
}> {}

/**
 * JSON text files in one private directory: `<name>.json`, guarded by `<name>.lock`. Callers
 * validate names, own the file format, and choose the error and the size limit.
 */
export const protectedFiles = <E>(
  directory: string,
  failure: (name: string) => E,
  maxBytes = Infinity,
) => {
  const path = (name: string) => join(directory, `${name}.json`);

  const attempt = <A>(name: string, run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: () => failure(name) });

  return {
    /** Narrows the file to its owner and returns its text; null when it or the directory is missing. */
    read: (name: string) =>
      attempt(name, async () =>
        (await ensurePrivateDirectory(directory, { create: false }))
          ? readProtectedFile(path(name), { maxBytes, makePrivate: true })
          : null,
      ),
    /** Creates the directory and holds the file's owner lock until the scope closes. */
    lock: (name: string) =>
      attempt(name, () => ensurePrivateDirectory(directory)).pipe(
        Effect.andThen(acquireOwnerLock(join(directory, `${name}.lock`))),
      ),
    /** Atomically replaces the file; null removes it. */
    write: (name: string, contents: string | null) =>
      attempt(name, () =>
        contents === null ? unlinkIfPresent(path(name)) : writeFileAtomic(path(name), contents),
      ),
  };
};

const failure = (name: string) =>
  new RecordStoreError({ message: `Cannot read or write Poppet's protected ${name} record.` });

const RecordName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,79}$/));

/**
 * Versioned JSON records beside API keys in `<data directory>/auth`, with the same private
 * directory, regular-file and owner-lock protections. Each record names itself, so a copied or
 * renamed file is rejected rather than read as another record. Callers decode the JSON data.
 */
export const makeRecordStore = (dataDirectory: string) => {
  const files = protectedFiles(join(dataDirectory, "auth"), failure, 65536);

  const Saved = Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(1), name: RecordName, data: Schema.Json }),
  );

  const checked = (name: string) =>
    Schema.decodeUnknownEffect(RecordName)(name).pipe(Effect.mapError(() => failure(name)));

  const load = (name: string) =>
    Effect.gen(function* () {
      const contents = yield* files.read(name);

      if (contents === null) return null;

      const saved = yield* Schema.decodeUnknownEffect(Saved, { onExcessProperty: "error" })(
        contents,
      ).pipe(Effect.mapError(() => failure(name)));

      if (saved.name !== name) return yield* Effect.fail(failure(name));

      return saved.data;
    });

  const read = (name: string) => checked(name).pipe(Effect.andThen(load(name)));

  /**
   * Holds the record's lock while `change` reads the current value and returns its replacement;
   * null removes the record. Another process holding the lock is waited for briefly, so two
   * refreshes never both spend a single-use token.
   */
  const update = <E, R>(
    name: string,
    change: (current: Schema.Json | null) => Effect.Effect<Schema.Json | null, E, R>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* checked(name);
        yield* files.lock(name).pipe(
          Effect.retry({
            while: (error) => error instanceof OwnerLockError && error.reason === "busy",
            schedule: Schedule.spaced("50 millis"),
            times: 100,
          }),
          Effect.mapError(() => failure(name)),
        );

        const next = yield* change(yield* load(name));

        const contents =
          next === null
            ? null
            : yield* Schema.encodeEffect(Saved)({ version: 1, name, data: next }).pipe(
                Effect.mapError(() => failure(name)),
              );

        yield* files.write(name, contents).pipe(Effect.uninterruptible);

        return next;
      }),
    );

  return { read, update };
};
