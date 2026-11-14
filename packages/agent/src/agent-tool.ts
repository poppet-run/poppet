import type { AttachmentReference, ModelOperations, Output, Tool } from "@poppet/provider";
import type {
  DeliveryDestination,
  Run,
  SkillSnapshot,
  StoredMessage,
  StoreError,
} from "@poppet/store";
import type { Effect } from "effect";

import type { ApproveCommand } from "#src/bash";
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
  readonly approveCommand: ApproveCommand | null;
  readonly here: Effect.Effect<DeliveryDestination, AgentError> | null;
  readonly home: Effect.Effect<DeliveryDestination, AgentError> | null;
  readonly destination:
    | ((conversationId: string) => Effect.Effect<DeliveryDestination, AgentError>)
    | null;
}

export interface ToolContext extends RunContext {
  readonly pageURLs: ReadonlySet<string>;
}

export interface PreparedCall {
  readonly execute: Effect.Effect<string, AgentError | StoreError>;
  readonly grantedURLs?: () => ReadonlyArray<string>;
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
  ) => Effect.Effect<PreparedCall, AgentError | StoreError>;
  readonly untrustedResult: boolean;
  readonly withdrawnWhenUntrusted: boolean;
  readonly contextOnly: boolean;
  readonly availableWhenScheduled: boolean;
  readonly failures: FailurePolicy;
  readonly uninterruptible?: boolean;
  readonly recordsOwnResult?: boolean;
  readonly external?: { readonly serverId: string; readonly toolName: string };
}

export const reportedReasons: ReadonlySet<string> = new Set([
  "tool-arguments",
  "tool-permission",
  "tool-network",
  "tool-authentication",
  "tool-rate-limit",
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
