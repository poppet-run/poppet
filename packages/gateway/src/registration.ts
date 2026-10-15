import { Context, type Effect, type Layer, type Redacted } from "effect";

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
  /** Inspects settings; building the returned layer starts the connection. Null means unconfigured. */
  readonly load: Effect.Effect<
    Layer.Layer<MessagingChannel, ChannelError> | null,
    ChannelError,
    ChannelEnvironment
  >;
}
