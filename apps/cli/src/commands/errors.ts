import { Data } from "effect";

export class UsageError extends Data.TaggedError("UsageError")<{
  readonly message: string;
}> {}
