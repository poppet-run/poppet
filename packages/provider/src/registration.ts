import { Context, Effect, Layer, Redacted, Schema } from "effect";

import type { ProviderId } from "#src/schema";
import type { Provider, ProviderError } from "#src/service";

export class ProviderEnvironment extends Context.Service<
  ProviderEnvironment,
  {
    readonly applicationName: string;
    readonly dataDirectory: string;
  }
>()("poppet/ProviderEnvironment") {}

export class CredentialInput extends Context.Service<
  CredentialInput,
  {
    readonly readKey: (
      provider: ProviderId,
    ) => Effect.Effect<Redacted.Redacted<string>, ProviderError>;
    readonly readLine: (
      provider: ProviderId,
      prompt: string,
    ) => Effect.Effect<string, ProviderError>;
  }
>()("poppet/CredentialInput") {}

export interface LoginOptions {
  readonly openBrowser: boolean;
  readonly callbackPort: number | null;
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
    readonly apiKey: boolean;
    readonly help: string;
  };
  readonly inspectSaved?: (directory: string) => Effect.Effect<
    {
      readonly connected: boolean;
      readonly expiresAt: number | null;
      readonly source: "local" | "saved";
    },
    ProviderError
  >;
  readonly layer: Layer.Layer<Provider | ProviderConnection, ProviderError, ProviderEnvironment>;
}
