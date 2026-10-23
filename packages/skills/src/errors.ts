import { Data } from "effect";

export class SkillError extends Data.TaggedError("SkillError")<{
  readonly reason: "storage" | "corrupt" | "invalid-request" | "not-found" | "conflict" | "limit";
  readonly message: string;
}> {}
