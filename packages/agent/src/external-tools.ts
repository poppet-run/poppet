import type { Tool } from "@poppet/provider";
import { Context, type Effect, type Scope } from "effect";

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
  readonly name: "external";
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
