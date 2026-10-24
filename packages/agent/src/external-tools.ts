import type { Tool } from "@poppet/provider";
import { Context, type Effect, type Scope } from "effect";

import type { AgentTool, FailurePolicy } from "#src/agent-tool";
import type { AgentError } from "#src/errors";

/** Host-supplied tools join the existing loop, with immutable identity and per-run permissions. */
export interface ExternalTool {
  readonly definition: Tool;
  readonly serverId: string;
  readonly toolName: string;
  /** Host-owned tools may stay after untrusted content enters a run; others are withdrawn. */
  readonly availableAfterUntrusted?: boolean;
  readonly prepare: (argumentsJSON: string) => Effect.Effect<PreparedExternalCall, AgentError>;
}

export interface PreparedExternalCall {
  readonly execute: Effect.Effect<string, AgentError>;
}

export class ExternalTools extends Context.Service<
  ExternalTools,
  {
    /** Host-owned policy text, never server instructions or tool descriptions. */
    readonly instructions?: string;
    readonly snapshot: (
      scheduled: boolean,
      run: { readonly sessionId: string; readonly runId: string },
    ) => Effect.Effect<ReadonlyArray<ExternalTool>, AgentError, Scope.Scope>;
  }
>()("poppet/ExternalTools") {}

/** Only a failure the server reported is known to have changed nothing. */
export const externalFailures: FailurePolicy = {
  reported: new Set(["agent:tool-reported"]),
  uncertain: new Set(),
  otherwise: "uncertain",
};

/** External results are untrusted; the host decides scheduled access in its snapshot. */
export const externalAgentTool = (entry: ExternalTool): AgentTool => ({
  definition: entry.definition,
  prepare: (call) => entry.prepare(call.arguments),
  untrustedResult: true,
  withdrawnWhenUntrusted: entry.availableAfterUntrusted !== true,
  contextOnly: false,
  mutating: false,
  failures: externalFailures,
  external: { serverId: entry.serverId, toolName: entry.toolName },
});
