import { Context, Effect, Layer, Redacted, Schema } from "effect";

import type { ProviderId } from "#src/schema";
import type { Provider, ProviderError } from "#src/service";

/** Host settings available to provider implementations. */
export class ProviderEnvironment extends Context.Service<
  ProviderEnvironment,
  {
    readonly applicationName: string;
    readonly dataDirectory: string;
  }
>()("poppet/ProviderEnvironment") {}

/** Host-owned terminal input that providers request when a key is needed. */
export class CredentialInput extends Context.Service<
  CredentialInput,
  {
    readonly readKey: (
      provider: ProviderId,
      stdin: boolean,
    ) => Effect.Effect<Redacted.Redacted<string>, ProviderError>;
  }
>()("poppet/CredentialInput") {}

/** Key-input choices supplied by the host's login command. */
export interface LoginOptions {
  readonly keyStdin: boolean;
}

/** Provider-owned authentication, connection status, and live model verification. */
export interface ConnectionOperations {
  readonly login: (options: LoginOptions) => Effect.Effect<string, ProviderError, CredentialInput>;
  readonly status: Effect.Effect<Schema.JsonObject, ProviderError>;
  readonly logout: Effect.Effect<string, ProviderError>;
  /** Runs live inference checks; a null model lets the provider choose or require one. */
  readonly verify: (model: string | null) => Effect.Effect<string, ProviderError>;
}

/** Supplies authentication commands independently of model inference. */
export class ProviderConnection extends Context.Service<ProviderConnection, ConnectionOperations>()(
  "poppet/ProviderConnection",
) {}

/** Everything the host needs to register a provider without knowing its implementation. */
export interface ProviderRegistration {
  readonly id: ProviderId;
  readonly name: string;
  readonly authentication: {
    readonly apiKey: boolean;
    readonly help: string;
  };
  readonly layer: Layer.Layer<Provider | ProviderConnection, ProviderError, ProviderEnvironment>;
}
