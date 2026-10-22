# OpenAI-compatible providers

[Refactoring plans](index.md)

## Goal

Reduce `provider-opencode` and `provider-openrouter` to their model lists,
catalog filters, and protocol options. Share the SDK client setup with
`provider-openai`.

## Current state

`packages/provider-opencode/src/service.ts` and
`packages/provider-openrouter/src/service.ts` share this structure:

- `export type HttpFetch` (also defined again in
  `provider-openai/src/oauth/http.ts`).
- A hard-coded `"poppet/0.0.0"` user agent.
- Catalog discovery: `GET {baseUrl}/models` inside `Effect.tryPromise`, cancel
  the body on a non-OK response and throw `APIError`, map a JSON failure to
  "returned an invalid model catalog", map a schema failure to "returned an
  unsupported model catalog", and apply a 30-second `timeoutOrElse` with a
  `temporary` `ProviderError`.
- `new OpenAI({ apiKey, baseURL, fetch, maxRetries: 0, logLevel: "off", timeout: 45_000, defaultHeaders })`
  from a key effect. `provider-openai/src/model/client.ts` (`clientFor`) builds
  the same client without headers.
- `loadApiKey = storedApiKey(id, env)`, an `inference` layer that provides
  `ProviderEnvironment` to `loadApiKey`, a `*Live` layer built from
  `makeApiKeyConnection` and `ApiKeyStoreLive`, and a `ProviderRegistration` with
  `consent: false, apiKey: true` and the same help text.

The differences:

- Error mapping: OpenCode uses `inferenceFailure("opencode-go", …)`; OpenRouter
  uses `routerFailure`.
- Request headers: OpenRouter adds `HTTP-Referer` and `X-OpenRouter-Title`.
- Catalog schema and the supported-model logic.
- OpenCode's coding-workload gate.

## Design

In `@poppet/provider`:

- Export `HttpFetch` and a `userAgent` constant.

In `@poppet/provider-protocol` (new `src/openai-compatible.ts`):

```ts
export const openAIClient: (options: {
  readonly key: Redacted.Redacted<string>;
  readonly baseUrl: string;
  readonly http: HttpFetch;
  readonly headers?: Record<string, string>;
}) => OpenAI;

export const fetchModelCatalog: <S extends Schema.Top>(options: {
  readonly provider: ProviderId;
  readonly label: string; // "OpenCode Go", "OpenRouter"
  readonly url: string;
  readonly http: HttpFetch;
  readonly headers: Record<string, string>;
  readonly schema: S;
  readonly failure: (cause: unknown) => ProviderError;
}) => Effect.Effect<S["Type"], ProviderError>;
```

In `@poppet/credentials`, next to `makeApiKeyConnection` (it already depends on
`@poppet/provider`):

```ts
export const apiKeyProvider: (options: {
  readonly id: ProviderId;
  readonly name: string;
  readonly environment: string;
  readonly make: (key: Effect.Effect<Redacted.Redacted<string>, ProviderError>) => ProviderOperations;
}) => { readonly loadApiKey: …; readonly layer: Layer…; readonly registration: ProviderRegistration };
```

## Steps

1. Export `HttpFetch` and `userAgent` from `@poppet/provider`. Switch the three
   provider packages to them and keep re-exports where tests import
   `HttpFetch` from `#src/service`.
2. Add `openAIClient` and use it in OpenCode, OpenRouter, and `clientFor`.
3. Add `fetchModelCatalog` and use it in both catalog effects. OpenRouter passes
   `routerFailure`. OpenCode passes `(cause) => inferenceFailure("opencode-go", cause)`.
   Check that OpenRouter's current double wrapping
   (`routerFailure(new APIError(...))` inside `try`, then `routerFailure` in
   `catch`) gives the same result through a single `failure`.
4. Add `apiKeyProvider` and rebuild both registrations with it. Keep the
   exported names (`OpenCodeGoLive`, `openCodeGo`, `OpenRouterLive`,
   `openRouter`, `loadApiKey`, `makeOpenCodeProvider`, `makeOpenRouterProvider`)
   so the CLI and tests don't change.

## Verification

`provider-opencode/src/service.test.ts`, `provider-openrouter/src/service.test.ts`,
and `provider-protocol/src/protocol.test.ts` should pass unchanged. Pay
particular attention to the catalog error messages, timeout behaviour, and the
headers sent on catalog and inference requests.
