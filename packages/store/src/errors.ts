import { Data, Effect, Schema } from "effect";
import { SqlError } from "effect/sql";

/** Distinguishes storage failures from invalid requests, missing records, and state conflicts. */
export class StoreError extends Data.TaggedError("StoreError")<{
  readonly reason:
    | "storage"
    | "busy"
    | "migration"
    | "corrupt"
    | "invalid-request"
    | "not-found"
    | "conflict";
  readonly message: string;
}> {}

export const storageFailure = (cause: unknown) =>
  cause instanceof StoreError
    ? cause
    : new StoreError({
        reason: "storage",
        message: "Poppet could not read or write its conversation store.",
      });

/**
 * Converts failures at the service boundary. Callers validate their input first,
 * so a schema failure here means a saved row no longer matches its schema.
 */
export const storeFailure = (cause: unknown) =>
  cause instanceof Schema.SchemaError
    ? new StoreError({
        reason: "corrupt",
        message: "The conversation store contains an invalid record.",
      })
    : storageFailure(cause);

/** Validates caller input, reporting a mismatch as an invalid request. */
export const decodeInput = <S extends Schema.Top>(
  schema: S,
  value: S["Encoded"],
  options?: { readonly onExcessProperty?: "error" },
) =>
  Schema.decodeUnknownEffect(
    schema,
    options,
  )(value).pipe(
    Effect.mapError(
      () =>
        new StoreError({
          reason: "invalid-request",
          message: "The conversation store request is invalid.",
        }),
    ),
  );

/**
 * Logs why storage failed, to stderr, so generic errors stay debuggable.
 * Only the SQLite message or a schema mismatch is logged, never saved content.
 */
export const logStorageCause = (cause: unknown) =>
  cause instanceof SqlError.SqlError
    ? Effect.logError(
        "Storage query failed",
        cause.reason.cause instanceof Error ? cause.reason.cause.message : cause.message,
      )
    : cause instanceof Schema.SchemaError
      ? Effect.logError("A saved record does not match its schema")
      : Effect.void;

/** Logs an unexpected storage cause, then reports it with the caller's error type. */
export const reportAs =
  <B>(convert: (cause: unknown) => B) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.tapError(logStorageCause), Effect.mapError(convert));
