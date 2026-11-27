import { Context } from "effect";
import type { Effect, Layer, Redacted, Terminal } from "effect";
import type { Prompt } from "effect/cli";

import type { GatewayAdapter, GatewayError } from "#src/adapter";

export class GatewayEnvironment extends Context.Service<
  GatewayEnvironment,
  { readonly dataDirectory: string }
>()("poppet/GatewayEnvironment") {}

export class GatewayInput extends Context.Service<
  GatewayInput,
  { readonly readSecret: Effect.Effect<Redacted.Redacted<string>, GatewayError> }
>()("poppet/GatewayInput") {}

/** The `fetch` that interactive setup uses for live checks, replaceable in tests. */
export const GatewayFetch = Context.Reference<
  (url: string, init: RequestInit) => Promise<Response>
>("poppet/GatewayFetch", { defaultValue: () => (url, init) => globalThis.fetch(url, init) });

export interface GatewaySetupDraft {
  readonly summary: string;
  readonly save: Effect.Effect<string, GatewayError>;
}

export interface GatewayPromptSetup {
  readonly configured: Effect.Effect<boolean, GatewayError, GatewayEnvironment>;
  readonly prompt: Effect.Effect<
    GatewaySetupDraft,
    GatewayError | Terminal.QuitError,
    GatewayEnvironment | Prompt.Environment
  >;
  readonly remove: Effect.Effect<string, GatewayError, GatewayEnvironment>;
}

export interface GatewayRegistration {
  readonly id: string;
  readonly name: string;
  readonly setupHelp: string;
  readonly setup: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, GatewayError, GatewayEnvironment | GatewayInput>;
  readonly promptSetup?: GatewayPromptSetup;
  readonly load: Effect.Effect<
    Layer.Layer<GatewayAdapter, GatewayError> | null,
    GatewayError,
    GatewayEnvironment
  >;
}
