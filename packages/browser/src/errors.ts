import { Data } from "effect";

/** Browser failures retain their outcome when the host adapts them to its agent. */
export class BrowserError extends Data.TaggedError("BrowserError")<{
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
