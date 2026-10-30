# OpenCode Go

[Documentation index](../README.md)

For OpenCode Go, discovery uses its public catalog without an API key. Log in
with a hidden key prompt, then select a model:

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

## Models

The initial Go adapter supports `gpt-6-luna` through Responses and `glm-5.3`
through Chat Completions. Discovery lists those models when they appear in the
remote catalog. Other Go models, including the Messages protocol, are not yet
supported. Neither model accepts image attachments until image input is tested;
text-file attachments work. Both protocols send `poppet/0.0.0` and a stable `x-opencode-session`
header for the exchange.

Poppet uses the selected Go model without a separate workload setting.
See the provider documentation for usage requirements.
[OpenCode Go requirements and endpoints](https://opencode.ai/v2/docs/console/go/)

## Credentials

See [API keys](../configuration.md#api-keys) for protected storage, environment
overrides, stdin input, and logout. OpenCode Go uses `POPPET_OPENCODE_GO_API_KEY`
and `<POPPET_DATA_DIR>/auth/opencode-go.json`.

Use `chat new` to start a session; see [chat](../chat.md). Chat
consumes provider usage. Local tests do not establish live account access; see
[development and validation](../development.md#validation).
