# OpenRouter

[Documentation index](../index.md)

For OpenRouter, discovery uses its public catalog without an API key. Select a
concrete model ID and save a key through login:

```fish
set -lx POPPET_PROVIDER openrouter
bun run start provider models
set -lx POPPET_MODEL anthropic/claude-sonnet-4.5
bun run start auth login openrouter
bun run start provider verify
```

## Credentials

See [API keys](../configuration.md#api-keys) for protected storage, environment
overrides, stdin input, and logout. OpenRouter uses `POPPET_OPENROUTER_API_KEY`
and `<POPPET_DATA_DIR>/auth/openrouter.json`.

## Models and requests

Verification requires a catalog model with tool support and makes two requests
that consume OpenRouter credits. The key is redacted and omitted from `config`.
The adapter accepts both assistant and coding workloads through Chat Completions.
It derives tools, temperature, output limits, and context size from catalog
metadata. Models that generate images or audio and dynamic model routers such as
`openrouter/auto` and `openrouter/free` are excluded.

Requests require support for every requested parameter and disable provider
fallbacks. A stable `session_id` groups the exchange. Plain reasoning and the
complete structured reasoning sequence survive tool calls. Credit exhaustion,
rate limits, upstream failures, and interrupted streams produce typed errors;
requests are not automatically retried.
[OpenRouter routing](https://openrouter.ai/docs/guides/routing/provider-selection),
[reasoning continuation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens),
and [stream errors](https://openrouter.ai/docs/api/reference/streaming).

See [provider selection](../cli.md#providers-and-models) for verification with an explicit provider and [development and validation](../development.md#validation) for test coverage and live-check limits.
