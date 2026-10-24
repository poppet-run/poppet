import { Context, type Effect, type Layer, type Redacted, type Terminal } from "effect";
import type { Prompt } from "effect/cli";

import type { ChannelError, MessagingChannel } from "#src/channel";

/** Host storage location available during channel setup and loading. */
export class ChannelEnvironment extends Context.Service<
  ChannelEnvironment,
  { readonly dataDirectory: string }
>()("poppet/ChannelEnvironment") {}

/** Host-owned secret input requested by adapters during setup. */
export class ChannelInput extends Context.Service<
  ChannelInput,
  { readonly readSecret: Effect.Effect<Redacted.Redacted<string>, ChannelError> }
>()("poppet/ChannelInput") {}

/** Host-facing channel setup and loading without a dependency on a concrete adapter. */
export interface ChannelRegistration {
  readonly id: string;
  readonly name: string;
  readonly setupHelp: string;
  readonly setup: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, ChannelError, ChannelEnvironment | ChannelInput>;
  /** Collects interactive choices, returning a save operation or null when skipped. */
  readonly promptSetup?: Effect.Effect<
    Effect.Effect<string, ChannelError> | null,
    ChannelError | Terminal.QuitError,
    ChannelEnvironment | Prompt.Environment
  >;
  /** Inspects settings; building the returned layer starts the connection. Null means unconfigured. */
  readonly load: Effect.Effect<
    Layer.Layer<MessagingChannel, ChannelError> | null,
    ChannelError,
    ChannelEnvironment
  >;
}
