import { Data } from "effect";

/** A chat orchestration failure, including invalid history, tool restrictions, and run budgets. */
export class AgentError extends Data.TaggedError("AgentError")<{
  readonly reason:
    | "invalid-request"
    | "context-limit"
    | "history"
    | "protocol"
    | "output-limit"
    | "interrupted"
    | "tool-arguments"
    | "tool-permission"
    | "tool-network"
    | "tool-authentication"
    | "tool-rate-limit"
    | "tool-storage"
    | "tool-limit"
    | "budget"
    | "memory-storage"
    | "memory-limit";
  readonly message: string;
}> {}
