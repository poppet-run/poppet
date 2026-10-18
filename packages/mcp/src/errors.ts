import { Data } from "effect";

/** Protocol and tool failures retain their outcome when the host adapts them to its agent. */
export class MCPError extends Data.TaggedError("MCPError")<{
  readonly reason:
    | "tool-arguments"
    | "tool-permission"
    | "tool-network"
    | "tool-reported"
    | "tool-uncertain";
  readonly message: string;
}> {}
