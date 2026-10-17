import { Data, Schema } from "effect";

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

export const corruptRecord = () =>
  new StoreError({
    reason: "corrupt",
    message: "The conversation store contains an invalid record.",
  });

// Invalid saved data is corruption; the service classifies invalid caller input separately.
export const readRecord = <A>(read: () => A): A => {
  try {
    return read();
  } catch (cause) {
    if (cause instanceof Schema.SchemaError) throw corruptRecord();
    throw cause;
  }
};
