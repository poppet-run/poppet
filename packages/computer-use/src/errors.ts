import { Data } from "effect";

export class ComputerError extends Data.TaggedError("ComputerError")<{
  readonly reason:
    | "tool-arguments"
    | "tool-permission"
    | "tool-network"
    | "tool-storage"
    | "tool-limit"
    | "tool-reported"
    | "tool-uncertain";
  readonly message: string;
}> {}

export const computerFailure = (reason: ComputerError["reason"], message: string) =>
  new ComputerError({ reason, message });
