# OpenRouter

[Engineering notes](../README.md)

`openrouter` reuses the Chat Completions adapter from `@poppet/provider/protocol`.
The package is `@poppet/provider-openrouter`. The
[user guide](https://poppet.run/docs/providers/openrouter/) covers setup. See
[providers](../providers.md) for the shared contract.

## Discovery

`service.ts` reads the public catalog without a key. It takes tool support, image
input, temperature, output limits, and context size from catalog metadata. A
model accepts images when its input modalities include `image`. Discovery leaves
out models that generate images or audio and dynamic routers such as
`openrouter/auto` and `openrouter/free`. A malformed entry is skipped when the
catalog has usable entries. A dropped connection while downloading is a temporary
failure.

## Requests

Inference loads the key from `POPPET_OPENROUTER_API_KEY` or `auth/openrouter.json`
only when it starts. `protocol.ts` sets the routing rules:

- Requests require support for every parameter they send and turn off provider
  fallbacks. See [provider selection](https://openrouter.ai/docs/guides/routing/provider-selection).
- A stable `session_id` groups the exchange.
- Continuation keeps plain reasoning and the full structured reasoning sequence
  across tool calls. The adapter joins streaming fragments into blocks, in
  arrival order, and keeps their signatures and opaque metadata. See
  [reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).
- Credit exhaustion, rate limits, upstream failures, and mid-stream errors map to
  typed `ProviderError` reasons. See
  [stream errors](https://openrouter.ai/docs/api/reference/streaming).
