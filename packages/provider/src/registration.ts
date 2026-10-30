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

/** Host-owned terminal input that providers request when a key or pasted text is needed. */
export class CredentialInput extends Context.Service<
  CredentialInput,
  {
    readonly readKey: (
      provider: ProviderId,
      stdin: boolean,
    ) => Effect.Effect<Redacted.Redacted<string>, ProviderError>;
    /** Reads one visible line; without an interactive terminal it never completes. */
    readonly readLine: (
      provider: ProviderId,
      prompt: string,
    ) => Effect.Effect<string, ProviderError>;
  }
>()("poppet/CredentialInput") {}

/** Sign-in choices supplied by the host's login command. */
export interface LoginOptions {
  readonly keyStdin: boolean;
  /** False prints the sign-in link instead of opening the system browser. */
  readonly openBrowser: boolean;
  /** A fixed browser-callback port, such as one forwarded over SSH; null picks any free port. */
  readonly callbackPort: number | null;
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
  /** Read local metadata only: no writes, locks, token refresh, or network access. */
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
