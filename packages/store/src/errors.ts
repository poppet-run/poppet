import { Data, Effect, Schema } from "effect";

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
