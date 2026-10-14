import { Context, Effect, Layer, Redacted, Schema } from "effect";

import type { ProviderId } from "#src/schema";
import type { Provider, ProviderError } from "#src/service";

// The host supplies only the settings provider implementations need.
export class ProviderEnvironment extends Context.Service<
  ProviderEnvironment,
  {
    readonly applicationName: string;
    readonly dataDirectory: string;
  }
>()("poppet/ProviderEnvironment") {}

// Terminal input belongs to the host. Providers decide when it is needed.
export class CredentialInput extends Context.Service<
  CredentialInput,
  {
    readonly readKey: (
      provider: ProviderId,
      stdin: boolean,
    ) => Effect.Effect<Redacted.Redacted<string>, ProviderError>;
  }
>()("poppet/CredentialInput") {}

export interface LoginOptions {
  readonly consent: boolean;
  readonly keyStdin: boolean;
}

export interface ConnectionOperations {
  readonly login: (options: LoginOptions) => Effect.Effect<string, ProviderError, CredentialInput>;
  readonly status: Effect.Effect<Schema.JsonObject, ProviderError>;
  readonly logout: Effect.Effect<string, ProviderError>;
  readonly verify: (model: string | null) => Effect.Effect<string, ProviderError>;
}

export class ProviderConnection extends Context.Service<ProviderConnection, ConnectionOperations>()(
  "poppet/ProviderConnection",
) {}

export interface ProviderRegistration {
  readonly id: ProviderId;
  readonly name: string;
  readonly authentication: {
    readonly consent: boolean;
    readonly apiKey: boolean;
    readonly help: string;
  };
  readonly layer: Layer.Layer<Provider | ProviderConnection, ProviderError, ProviderEnvironment>;
}
