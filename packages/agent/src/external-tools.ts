import type { Tool } from "@poppet/provider";
import { Context, type Effect } from "effect";

import type { AgentError } from "#src/errors";

/** Host-supplied tools join the existing loop, with immutable identity and per-run permissions. */
export interface ExternalTool {
  readonly definition: Tool;
  readonly serverId: string;
  readonly toolName: string;
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
    ) => Effect.Effect<ReadonlyArray<ExternalTool>, AgentError>;
  }
>()("poppet/ExternalTools") {}
