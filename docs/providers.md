# Providers

[Engineering notes](README.md)

A provider package turns the shared model contract into requests to one service.
The agent never imports a concrete provider or its SDK types. It depends on
`ModelResolver`, which the CLI runtime supplies, and calls the resolved model
through the contract. Adapter notes are in [ChatGPT](providers/openai-chatgpt.md),
[OpenCode](providers/opencode.md), [OpenRouter](providers/openrouter.md), and
[Gemini](providers/gemini.md).

| Workspace                     | Owns                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `@poppet/provider`            | Contracts, registration, verification, and protocol adapters under `./protocol` |
| `@poppet/provider-openai`     | ChatGPT sign-in, credentials, catalog, and Responses inference                  |
| `@poppet/provider-opencode`   | `opencode` and `opencode-go` catalogs, keys, and protocol routing               |
| `@poppet/provider-openrouter` | OpenRouter catalog capabilities and Chat Completions routing                    |
| `@poppet/provider-gemini`     | Gemini catalog and native streaming inference                                   |
| `@poppet/cli`                 | The registration list and composition of the selected provider's layer          |

## Contract

```ts
interface ProviderOperations {
  readonly models: Effect.Effect<ReadonlyArray<ModelDescription>, ProviderError>;
  readonly resolve: (modelId: string) => Effect.Effect<ModelOperations, ProviderError>;
}

interface ModelOperations {
  readonly description: ModelDescription;
  readonly stream: (request: ModelRequest) => Stream.Stream<ModelEvent, ProviderError>;
}
```

`resolve` validates and binds a model. The agent resolves the session's saved
selection and calls `stream` for each model turn. Supporting types live in
`provider/src/schema.ts` and use Effect Schema for anything external.

- `ModelDescription` has the provider ID, model ID, display name, and
  capabilities: tool support, image input, accepted generation settings, and
  context and output limits. Missing metadata is explicit. Unsupported settings
  fail before inference.
- `ModelRequest` has a stable session ID, instructions, ordered history, tool
  definitions, and validated settings. History holds user text, assistant text,
  tool calls, and tool results, with call IDs and order preserved. Adapters
  translate tool definitions to their wire format.
- `ModelEvent` is an answer delta, a readable reasoning delta, or a completed
  response with the authoritative ordered output, tool calls, finish reason, and
  optional usage.
- `ProviderError` separates authentication, permission, quota, rate limiting,
  temporary failure, invalid request, context limit, and interrupted inference.
  It carries safe provider error codes and request IDs when they are short
  identifiers without spaces or control characters.

Expected failures use the stream's error channel. Reasoning diagnostics stay
apart from answer output and from encrypted continuation.

## Adapter rules

- Emit a completion only after the protocol confirms a successful terminal
  response. A missing completion, a failed response, or an incomplete stream
  fails even when text or tool arguments already arrived. Partial tool arguments
  never authorize a call.
- Scope the active request and close it on failure, interruption, or when the
  consumer stops early. A scoped abort controller and the Effect clock enforce a
  60-second absolute inference deadline (`timeouts.inferenceSeconds`). HTTP
  requests to OpenAI-compatible endpoints time out after 45 seconds
  (`timeouts.providerRequestSeconds`), and catalog requests after 30
  (`timeouts.modelCatalogSeconds`). Consumer termination aborts the request
  before waiting on iterator cleanup, so a pending read cannot block
  cancellation.
- Never retry a model request. SDK retries are off.
- Save a versioned continuation payload with each assistant message: encrypted
  reasoning, protocol response items, or provider reasoning sequences. Only the
  matching adapter reads it. Reject continuation whose provider, model, version,
  or protocol does not match. Keep credentials out of transcripts and
  continuation.

## Protocol adapters

`@poppet/provider/protocol` holds the Responses and Chat Completions codecs and
`scoped-stream.ts`. A provider with its own wire protocol uses `modelStream` and
`userParts` from there directly. They bind a model description to a client Effect that the
provider supplies, together with request headers, error classification, and
reasoning-continuation extensions. Shared adapters never branch on provider IDs
or open a provider's credential store. The root `@poppet/provider` export has no
SDK types or protocol code. The `./protocol` export carries the OpenAI SDK
dependency. Adapter tests use injected HTTP responses and a test clock.

## Registration

`ProviderRegistration` has an ID, display name, authentication capabilities, help
text, and a layer that supplies `Provider` and `ProviderConnection`.
`ProviderConnection` has login, secret-free status, logout, verification, and an
optional operation to forget a saved registration. Login returns guidance, and
verification returns the verified model ID. `verifyModel` in
`provider/src/verification.ts` is the shared tool round-trip check. The layer may
require `ProviderEnvironment`, which holds the application name and data
directory, and can ask for terminal input through `CredentialInput`.

Provider IDs are bounded, path-safe strings, not an enumeration. The first entry
in `apps/cli/src/providers.ts` is the default. Unknown IDs fail before any
provider resource opens. The store validates IDs and keeps continuation without
the provider being installed. `runtime.ts` builds only the selected provider's
layer, for an auth command or inside a run's stream scope.

Auth commands take an explicit provider or use `provider` from `config.json`.
API-key providers use `@poppet/credentials`, which stores versioned files at
`auth/<id>.json` and returns redacted keys. The environment variable wins over
the file. Login needs masked terminal input. Saving a key does not prove remote
access, which verification checks. Logout deletes the saved key, and a key from
the environment stays under the shell's control.

## Adding a provider

1. Create a workspace package that exports a `ProviderRegistration`. Implement
   `Provider` and `ProviderConnection` and compose their live dependencies inside
   the package. An API-key provider can use `apiKeyProvider` from
   `@poppet/credentials` with its own ID and environment variable name.
2. Add it to `apps/cli/src/providers.ts` and to the CLI's dependencies, then run
   `bun install`.
3. Add a page under `docs/providers/` and to the website.

Shared schemas, storage, configuration, and command routing need no changes.
Lint restricts concrete provider imports to the registration list. The package
owns its authentication, environment variable name, protocol choice, headers,
continuation extensions, and error rules, and passes them to shared helpers.
