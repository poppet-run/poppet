import { Data } from "effect";

export class AgentError extends Data.TaggedError("AgentError")<{
  readonly reason:
    | "invalid-request"
    | "context-limit"
    | "history"
    | "protocol"
    | "tools-unavailable"
    | "output-limit"
    | "interrupted";
  readonly message: string;
}> {}
