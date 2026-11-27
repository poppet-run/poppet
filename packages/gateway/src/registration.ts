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

export interface GatewayPromptSetup {
  readonly configured: Effect.Effect<boolean, GatewayError, GatewayEnvironment>;
  readonly prompt: Effect.Effect<
    Effect.Effect<string, GatewayError>,
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
