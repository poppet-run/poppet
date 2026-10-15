import { Context, type Effect, type Layer, type Redacted } from "effect";

import type { ChannelError, MessagingChannel } from "#src/channel";

export class ChannelEnvironment extends Context.Service<
  ChannelEnvironment,
  { readonly dataDirectory: string }
>()("poppet/ChannelEnvironment") {}

// The host owns secret input; adapters decide when setup needs it.
export class ChannelInput extends Context.Service<
  ChannelInput,
  { readonly readSecret: Effect.Effect<Redacted.Redacted<string>, ChannelError> }
>()("poppet/ChannelInput") {}

export interface ChannelRegistration {
  readonly id: string;
  readonly name: string;
  readonly setupHelp: string;
  readonly setup: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, ChannelError, ChannelEnvironment | ChannelInput>;
  // Loading inspects settings. Building the returned layer starts the connection.
  readonly load: Effect.Effect<
    Layer.Layer<MessagingChannel, ChannelError> | null,
    ChannelError,
    ChannelEnvironment
  >;
}
