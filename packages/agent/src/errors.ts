import { Data } from "effect";

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
    | "tool-storage"
    | "tool-limit"
    | "budget";
  readonly message: string;
}> {}
