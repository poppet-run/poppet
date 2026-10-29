import { join } from "node:path";

import {
  ensurePrivateDirectory,
  readProtectedFile,
  unlinkIfPresent,
  writeFileAtomic,
} from "@poppet/io";
import { Data, Effect, Schedule, Schema } from "effect";

import { acquireOwnerLock, type OwnerLockError } from "#src/lock";

/** A protected record could not be read, locked, or replaced. */
export class RecordStoreError extends Data.TaggedError("RecordStoreError")<{
  readonly message: string;
}> {}

const failure = (name: string) => () =>
  new RecordStoreError({ message: `Cannot read or write Poppet's protected ${name} record.` });

const RecordName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,79}$/));

/**
 * Versioned JSON records beside API keys in `<data directory>/auth`, with the same private
 * directory, regular-file and owner-lock protections. Each record names itself, so a copied or
 * renamed file is rejected rather than read as another record. Callers decode the JSON data.
 */
export const makeRecordStore = (dataDirectory: string) => {
  const directory = join(dataDirectory, "auth");

  const Saved = Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(1), name: RecordName, data: Schema.Json }),
  );

  const checked = (name: string) =>
    Schema.decodeUnknownEffect(RecordName)(name).pipe(Effect.mapError(failure(name)));

  const load = (name: string) =>
    Effect.gen(function* () {
      if (
        !(yield* Effect.tryPromise({
          try: () => ensurePrivateDirectory(directory, { create: false }),
          catch: failure(name),
        }))
      )
        return null;

      const contents = yield* Effect.tryPromise({
        try: () =>
          readProtectedFile(join(directory, `${name}.json`), {
            maxBytes: 65536,
            makePrivate: true,
          }),
        catch: failure(name),
      });

      if (contents === null) return null;

      const saved = yield* Schema.decodeUnknownEffect(Saved, { onExcessProperty: "error" })(
        contents,
      ).pipe(Effect.mapError(failure(name)));

      if (saved.name !== name) return yield* Effect.fail(failure(name)());

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
        yield* Effect.tryPromise({
          try: () => ensurePrivateDirectory(directory),
          catch: failure(name),
        });
        yield* acquireOwnerLock(join(directory, `${name}.lock`)).pipe(
          Effect.retry({
            while: (error: OwnerLockError) => error.reason === "busy",
            schedule: Schedule.spaced("50 millis"),
            times: 100,
          }),
          Effect.mapError(failure(name)),
        );

        const next = yield* change(yield* load(name));
        const path = join(directory, `${name}.json`);

        const contents =
          next === null
            ? null
            : yield* Schema.encodeEffect(Saved)({ version: 1, name, data: next }).pipe(
                Effect.mapError(failure(name)),
              );

        yield* Effect.tryPromise({
          try: () => (contents === null ? unlinkIfPresent(path) : writeFileAtomic(path, contents)),
          catch: failure(name),
        }).pipe(Effect.uninterruptible);

        return next;
      }),
    );

  return { read, update };
};
