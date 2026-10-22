import { Data } from "effect";

export class WebSearchError extends Data.TaggedError("WebSearchError")<{
  readonly reason: "tool-authentication" | "tool-rate-limit" | "tool-network" | "tool-limit";
  readonly message: string;
}> {}
