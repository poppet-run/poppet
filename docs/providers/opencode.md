# OpenCode

[Documentation index](../README.md)

For OpenCode pay-as-you-go (`opencode`), discovery fetches the catalog from
`https://opencode.ai/inference/openai/v1/models`. When an API key is configured,
Poppet authenticates the request so OpenCode returns only the models enabled for
that workspace (applying workspace model toggles, privacy, and region settings).
Without a configured key, discovery falls back to the public OpenCode catalog. A
connection drop while downloading the catalog is reported as a temporary failure.
Log in with a hidden key prompt, then select a model:

Save the provider and model in `config.json`:

```json
{
  "provider": "opencode",
  "model": "claude-sonnet-5-5"
}
```

```sh
poppet provider login opencode
poppet provider models opencode
```

For OpenCode Go subscription billing, see [OpenCode Go](opencode-go.md).

## Models

Discovery lists paid chat models from the OpenCode catalog, using each model's
reported display name, context window, output token limit, tool support, temperature
support, and image-input modalities. Free-tier chat models (which OpenCode restricts
to its own app), decision models, embedding models, and non-text models are excluded.

Models whose recommended API is OpenAI Responses use `/responses`; Chat Completions
models and models served through OpenCode Console's server-side protocol translation
(such as Anthropic Messages and Gemini models) use `/chat/completions`. Both
protocols send `poppet/0.0.0` and a stable `x-opencode-session` header for the
exchange.

Poppet uses the selected model without a separate workload setting.
See the provider documentation for usage requirements and workspace model controls.
[OpenCode Console models](https://opencode.ai/docs/console/models/)

## Credentials

See [API keys](../configuration.md#api-keys) for protected storage, environment
overrides, masked terminal input, and logout. OpenCode uses `POPPET_OPENCODE_API_KEY`
and `<POPPET_DATA_DIR>/auth/opencode.json`. Service account keys need the
**Models › Read** permission for authenticated model discovery; personal API keys work
without extra permissions.

Use `chat new` to start a session; see [chat](../chat.md). Chat
consumes provider usage. Local tests do not establish live account access; see
[development and validation](../development.md#validation).
