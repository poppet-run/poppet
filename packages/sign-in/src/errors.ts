import { Data } from "effect";

export class SignInError extends Data.TaggedError("SignInError")<{
  readonly reason: "callback" | "denied";
  readonly message: string;
}> {}
