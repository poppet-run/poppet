import { Context, type Effect, type Layer, type Redacted, type Terminal } from "effect";
import type { Prompt } from "effect/cli";

import type { ChannelError, MessagingChannel } from "#src/channel";

export class ChannelEnvironment extends Context.Service<
  ChannelEnvironment,
  { readonly dataDirectory: string }
>()("poppet/ChannelEnvironment") {}

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
  readonly promptSetup?: Effect.Effect<
    Effect.Effect<string, ChannelError> | null,
    ChannelError | Terminal.QuitError,
    ChannelEnvironment | Prompt.Environment
  >;
  readonly load: Effect.Effect<
    Layer.Layer<MessagingChannel, ChannelError> | null,
    ChannelError,
    ChannelEnvironment
  >;
}
