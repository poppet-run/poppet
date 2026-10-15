import { Data } from "effect";

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
