import { Data } from "effect";

export class MCPError extends Data.TaggedError("MCPError")<{
  readonly reason:
    | "tool-arguments"
    | "tool-permission"
    | "tool-network"
    | "tool-reported"
    | "tool-uncertain";
  readonly message: string;
}> {}
