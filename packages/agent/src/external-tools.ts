import type { Tool } from "@poppet/provider";
import { Context, type Effect, type Scope } from "effect";

import type { AgentTool, FailurePolicy } from "#src/agent-tool";
import type { AgentError } from "#src/errors";

export interface ExternalTool {
  readonly definition: Tool;
  readonly serverId: string;
  readonly toolName: string;
  readonly availableAfterUntrusted?: boolean;
  readonly prepare: (argumentsJSON: string) => Effect.Effect<PreparedExternalCall, AgentError>;
}

export interface PreparedExternalCall {
  readonly execute: Effect.Effect<string, AgentError>;
}

export class ExternalTools extends Context.Service<
  ExternalTools,
  {
    readonly instructions?: string;
    readonly snapshot: (
      scheduled: boolean,
      run: { readonly sessionId: string; readonly runId: string },
    ) => Effect.Effect<ReadonlyArray<ExternalTool>, AgentError, Scope.Scope>;
  }
>()("poppet/ExternalTools") {}

export const externalFailures: FailurePolicy = {
  reported: new Set(["agent:tool-reported"]),
  uncertain: new Set(),
  otherwise: "uncertain",
};

export const externalAgentTool = (entry: ExternalTool): AgentTool => ({
  definition: entry.definition,
  prepare: (call) => entry.prepare(call.arguments),
  untrustedResult: true,
  withdrawnWhenUntrusted: entry.availableAfterUntrusted !== true,
  contextOnly: false,
  availableWhenScheduled: true,
  failures: externalFailures,
  external: { serverId: entry.serverId, toolName: entry.toolName },
});
