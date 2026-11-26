# OpenCode Go

[Documentation index](../README.md)

For OpenCode Go, discovery fetches the catalog from `https://opencode.ai/inference/go/openai/v1/models`.
When an API key is configured, Poppet authenticates the request so OpenCode returns
only the Go models enabled for that workspace (applying workspace privacy, region, and
model settings). Without a configured key, discovery falls back to the public Go
catalog. A connection drop while downloading the catalog is reported as a temporary
failure. Log in with a hidden key prompt, then select a model:

Save the provider and model in `config.json`:

```json
{
  "provider": "opencode-go",
  "model": "glm-5.3"
}
```

```sh
poppet provider login opencode-go
poppet provider models opencode-go
```

For OpenCode pay-as-you-go (workspace credit billing and Console model toggles), see
[OpenCode](opencode.md).

## Models

Discovery lists paid chat models from the OpenCode Go catalog, using each model's
reported display name, context window, output token limit, tool support, temperature
support, and image-input modalities. Free-tier chat models (which OpenCode restricts
to its own app), decision models, and embedding models are excluded.

Models whose recommended API is OpenAI Responses use `/responses`; Chat Completions
models and models served through OpenCode Console's server-side protocol translation
(such as Anthropic Messages and Gemini models) use `/chat/completions`. Both
protocols send `poppet/0.0.0` and a stable `x-opencode-session` header for the
exchange.

Poppet uses the selected Go model without a separate workload setting.
See the provider documentation for usage requirements and workspace model controls.
[OpenCode Go requirements and endpoints](https://opencode.ai/docs/console/go/)

## Credentials

See [API keys](../configuration.md#api-keys) for protected storage, environment
overrides, masked terminal input, and logout. OpenCode Go uses `POPPET_OPENCODE_GO_API_KEY`
and `<POPPET_DATA_DIR>/auth/opencode-go.json`. Service account keys need the
**Models › Read** permission for authenticated model discovery; personal API keys work
without extra permissions.

Use `chat new` to start a session; see [chat](../chat.md). Chat
consumes provider usage. Local tests do not establish live account access; see
[development and validation](../development.md#validation).
