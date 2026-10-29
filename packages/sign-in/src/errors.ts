import { Data } from "effect";

/** A browser authorization attempt failed, or the account owner declined it. */
export class SignInError extends Data.TaggedError("SignInError")<{
  readonly reason: "callback" | "denied";
  readonly message: string;
}> {}
