import type { AttachmentReference, ModelOperations, Output, Tool } from "@poppet/provider";
import type {
  Approval,
  ApprovalRule,
  ApprovalRuleMatcher,
  DeliveryDestination,
  Run,
  SkillSnapshot,
  StoredMessage,
  StoreError,
  ToolReview,
} from "@poppet/store";
import type { Effect, Schema } from "effect";

import type { ParkRequest } from "#src/approvals/action-approval";
import type { AgentError } from "#src/errors";

export type ToolCall = Extract<Output, { type: "tool-call" }>;

export interface RunContext {
  readonly run: Run;
  readonly model: ModelOperations;
  readonly text: string;
  readonly attachments: ReadonlyArray<AttachmentReference>;
  readonly history: ReadonlyArray<StoredMessage>;
  readonly runs: ReadonlyArray<Run>;
  readonly prompt: string;
  readonly origin: "interactive" | "scheduled";
  readonly selectedSkill: string | null;
  readonly mentionedSkills: ReadonlyArray<SkillSnapshot>;
  readonly taskNote: { readonly text: string | null } | null;
  // When set, a call that needs the owner parks the run with this route instead of blocking.
  readonly approvalRequester: Schema.JsonObject | null;
  // Optional upper bound on a parked approval's expiry timestamp (e.g., next scheduled slot).
  readonly approvalExpiresAt: number | null;
  // When set, the run continues from this decided approval instead of starting a turn.
  readonly resume: Approval | null;
  readonly here: Effect.Effect<DeliveryDestination, AgentError> | null;
  readonly home: Effect.Effect<DeliveryDestination, AgentError> | null;
  readonly destination:
    | ((conversationId: string) => Effect.Effect<DeliveryDestination, AgentError>)
    | null;
}

export interface ToolContext extends RunContext {
  readonly pageURLs: ReadonlySet<string>;
  readonly hasUntrustedContent: () => boolean;
  readonly matchApprovalRule: (
    matcher: ApprovalRuleMatcher,
  ) => Effect.Effect<ApprovalRule | null, StoreError>;
}

export interface PreparedCall {
  readonly execute: Effect.Effect<string, AgentError | StoreError>;
}

export interface ReviewableCall {
  readonly authorize: (
    record: (review: ToolReview) => Effect.Effect<void, StoreError>,
  ) => Effect.Effect<PreparedCall, AgentError | StoreError | ParkRequest>;
  // Runs the call as approved by the owner, without reviewing it again.
  readonly approved: PreparedCall;
}

export interface FailurePolicy {
  readonly reported: ReadonlySet<string>;
  readonly uncertain: ReadonlySet<string>;
  readonly otherwise: "uncertain" | "fatal";
  readonly journalFatalReply?: boolean;
}

export interface AgentTool {
  readonly definition: Tool;
  readonly prepare: (
    call: ToolCall,
    context: ToolContext,
  ) => Effect.Effect<PreparedCall | ReviewableCall, AgentError | StoreError>;
  readonly untrustedResult: boolean;
  readonly withdrawnWhenUntrusted: boolean;
  readonly contextOnly: boolean;
  readonly availableWhenScheduled: boolean;
  readonly failures: FailurePolicy;
  readonly uninterruptible?: boolean;
  readonly recordsOwnResult?: boolean;
  // Each call is reviewed before dispatch, and the journal keeps the decision.
  readonly reviewed?: boolean;
  readonly external?: {
    readonly serverId: string;
    readonly toolName: string;
  };
}

export const reportedReasons: ReadonlySet<string> = new Set([
  "tool-arguments",
  "tool-permission",
  "tool-network",
  "tool-storage",
  "tool-limit",
  "tool-reported",
  "memory-limit",
]);

export const reportedStoreReasons: ReadonlySet<string> = new Set([
  "invalid-request",
  "not-found",
  "conflict",
]);

const keyed = (source: "agent" | "store", reasons: ReadonlySet<string>) =>
  [...reasons].map((reason) => `${source}:${reason}`);

export const builtinFailures: FailurePolicy = {
  reported: new Set(keyed("agent", reportedReasons)),
  uncertain: new Set(),
  otherwise: "fatal",
};

export const contextTool = (
  tool: Pick<AgentTool, "definition" | "prepare" | "untrustedResult">,
): AgentTool => ({
  ...tool,
  withdrawnWhenUntrusted: false,
  contextOnly: true,
  availableWhenScheduled: true,
  failures: builtinFailures,
});
