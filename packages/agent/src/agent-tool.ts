import type { ModelOperations, Output, Tool } from "@poppet/provider";
import type { DeliveryDestination, Run, StoreError } from "@poppet/store";
import type { Effect } from "effect";

import type { ApproveCommand } from "#src/bash";
import type { AgentError } from "#src/errors";

export type ToolCall = Extract<Output, { type: "tool-call" }>;

/** What a call sees while preparing: the run it belongs to and the page URLs it may read so far. */
export interface ToolContext {
  readonly run: Run;
  readonly model: ModelOperations;
  /** The owner's request, or the saved prompt of a scheduled task. */
  readonly text: string;
  /** Scheduled runs exclude mutating tools and cannot ask the owner to approve commands. */
  readonly readOnlyTools: boolean;
  readonly approveCommand: ApproveCommand | null;
  readonly here: Effect.Effect<DeliveryDestination, AgentError> | null;
  readonly home: Effect.Effect<DeliveryDestination, AgentError> | null;
  readonly pageURLs: ReadonlySet<string>;
}

/** A validated call; nothing runs until the whole batch has prepared. */
export interface PreparedCall {
  readonly execute: Effect.Effect<string, AgentError | StoreError>;
  /** Page URLs a successful result lets fetch_page read later in this run. */
  readonly grantedURLs?: () => ReadonlyArray<string>;
}

/**
 * How execution failures end, keyed as `failureReason` renders them. Reported failures become
 * the call's reply. Uncertain failures may have changed state, so they end the run without
 * replay. Fatal failures also end the run.
 */
export interface FailurePolicy {
  readonly reported: ReadonlySet<string>;
  readonly uncertain: ReadonlySet<string>;
  readonly otherwise: "uncertain" | "fatal";
  /** Fatal failures still journal their reply, so the owner can see why the call stopped. */
  readonly journalFatalReply?: boolean;
}

/** One tool the model can call, with everything the loop needs to permit and journal it. */
export interface AgentTool {
  readonly definition: Tool;
  readonly prepare: (
    call: ToolCall,
    context: ToolContext,
  ) => Effect.Effect<PreparedCall, AgentError | StoreError>;
  /** The result carries content the owner did not write. */
  readonly untrustedResult: boolean;
  /** The tool is withdrawn once untrusted content enters the run. */
  readonly withdrawnWhenUntrusted: boolean;
  /** The result only adds context, so an oversized one can be refused without loss. */
  readonly contextOnly: boolean;
  /** The tool changes owner state, so read-only (scheduled) runs exclude it. */
  readonly mutating: boolean;
  readonly failures: FailurePolicy;
  /** Keep an atomic write and its durable result together on graceful cancellation. */
  readonly uninterruptible?: boolean;
  /** Execution commits its own receipt, so a completed call is not journaled again. */
  readonly recordsOwnResult?: boolean;
  /** Host identity journaled with each call to an external tool. */
  readonly external?: { readonly serverId: string; readonly toolName: string };
}

// Failures the model can see and recover from, because no effect is left unconfirmed.
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

/** Built-in tools report recoverable agent failures; anything else ends the run. */
export const builtinFailures: FailurePolicy = {
  reported: new Set(keyed("agent", reportedReasons)),
  uncertain: new Set(),
  otherwise: "fatal",
};
