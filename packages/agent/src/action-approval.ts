import type { StoreError, ToolApproval } from "@poppet/store";
import type { Effect, Schema } from "effect";

import type { BashArguments } from "#src/bash";
import type { AgentError } from "#src/errors";

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
