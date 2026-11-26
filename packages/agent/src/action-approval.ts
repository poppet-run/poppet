import type { StoreError, ToolApproval } from "@poppet/store";
import { Data } from "effect";
import type { Effect, Schema } from "effect";

import type { BashArguments } from "#src/bash";
import { AgentError } from "#src/errors";

export type ActionApproval =
  | (BashArguments & { readonly kind: "bash"; readonly reason: string })
  | {
      readonly kind: "mcp";
      readonly invocation: string;
      readonly target: string;
      readonly effects: string;
      readonly reason: string;
    };

export type ApproveAction = (
  approval: ActionApproval,
  recordAnswer?: (answer: ToolApproval) => Effect.Effect<void, StoreError>,
) => Effect.Effect<boolean, AgentError | StoreError>;

// Keep data on one line and prevent code-span breaks or invisible directional changes.
export const escapedApprovalJSON = (value: Schema.Json) =>
  JSON.stringify(value).replaceAll(
    /[`\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

// Raised by a reviewed tool when the run should wait for the owner instead of blocking.
// The loop saves the approval and ends the run's stream; the call stays pending.
export class ParkRequest extends Data.TaggedError("ParkRequest")<{
  readonly approval: ActionApproval;
}> {}

export const ownerDenied = (kind: ActionApproval["kind"]) =>
  kind === "mcp"
    ? new AgentError({
        reason: "mcp-denied",
        message: "The owner did not approve this MCP action. Nothing was executed.",
      })
    : new AgentError({
        reason: "command-denied",
        message: "The owner did not approve this command. Nothing was executed.",
      });
